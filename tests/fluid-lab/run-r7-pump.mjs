#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const instance = process.argv[2] || "clusterio-host-1-instance-1";
const controller = process.argv[3] || "surface-export-controller";
const notebook = process.argv[4] || "tests/fluid-lab/NOTEBOOK.md";

function rcon(command) {
	return execFileSync("docker", [
		"exec", controller,
		"npx", "clusterioctl",
		"--log-level", "error",
		"instance", "send-rcon", instance, command,
		"--config", "/clusterio/tokens/config-control.json",
	], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function lastLine(text) { return String(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1) || ""; }
function lua(body) {
	const wrapped = `local ok,result=pcall(function() ${body} end); if ok then rcon.print(helpers.table_to_json(result)) else rcon.print(helpers.table_to_json({success=false,error=tostring(result)})) end`;
	return JSON.parse(lastLine(rcon(`/sc ${wrapped}`)));
}
function stepPaused(ticks) {
	lua("game.tick_paused=true; return {success=true,tick=game.tick,game_paused=game.tick_paused}");
	rcon(`/step-tick ${ticks}`);
	lua("game.tick_paused=true; return {success=true,tick=game.tick,game_paused=game.tick_paused}");
}

const resetLua = `
local deleted = {}
for _, surface in pairs(game.surfaces) do
	local p = surface.platform
	if p and p.valid and string.find(p.name, "fluid-lab-", 1, true) then
		local ok, err = pcall(function() game.delete_surface(surface) end)
		deleted[#deleted + 1] = { name = p.name, ok = ok, error = ok and nil or tostring(err) }
	end
end
storage.fluid_lab = nil
__fluid_lab_read = nil
game.tick_paused = false
local leftovers = {}
for _, surface in pairs(game.surfaces) do
	local p = surface.platform
	if p and p.valid and string.find(p.name, "fluid-lab-", 1, true) then leftovers[#leftovers + 1] = p.name end
end
return { success = true, deleted = deleted, zero_storage = storage.fluid_lab == nil, zero_surfaces = #leftovers == 0, leftovers = leftovers, game_paused = game.tick_paused }
`;


const cleanupCheckLua = `
local leftovers = {}
for _, surface in pairs(game.surfaces) do
	local p = surface.platform
	if p and p.valid and string.find(p.name, "fluid-lab-", 1, true) then leftovers[#leftovers + 1] = p.name end
end
return { success = true, zero_storage = storage.fluid_lab == nil, zero_surfaces = #leftovers == 0, leftovers = leftovers, game_paused = game.tick_paused == true, tick = game.tick }
`;

function resetLab() {
	const first = lua(resetLua);
	rcon("/step-tick 2");
	const postTick = lua(cleanupCheckLua);
	return { ...first, post_tick: postTick, zero_storage: postTick.zero_storage, zero_surfaces: postTick.zero_surfaces, leftovers: postTick.leftovers, game_paused: postTick.game_paused, tick: postTick.tick };
}
const results = { script: "tests/fluid-lab/run-r7-pump.mjs", started: new Date().toISOString(), rungs: {}, errors: [] };

try {
	results.initial_reset = resetLab();
	results.rungs.setup = lua(`
		storage.fluid_lab = { records = {} }
		local force = game.forces.player
		local function read_entity(label, e)
			local boxes, direct_total, segment_total, seen = {}, 0, 0, {}
			local platform_paused = e and e.valid and e.surface and e.surface.platform and e.surface.platform.paused == true or nil
			if e and e.valid and e.fluidbox then
				for i = 1, #e.fluidbox do
					local row = { index = i }
					local f = e.fluidbox[i]
					if f then row.direct = { name = f.name, amount = f.amount, temperature = f.temperature }; direct_total = direct_total + (f.amount or 0) end
					local sid = nil
					pcall(function() sid = e.fluidbox.get_fluid_segment_id(i) end)
					row.segment_id = sid
					if sid and not seen[sid] then
						seen[sid] = true
						local contents = nil
						pcall(function() contents = e.fluidbox.get_fluid_segment_contents(i) end)
						row.segment_contents = contents
						if contents then for _, amount in pairs(contents) do segment_total = segment_total + amount end end
					end
					boxes[#boxes + 1] = row
				end
			end
			return { label = label, tick = game.tick, game_paused = game.tick_paused == true, platform_paused = platform_paused, valid = e and e.valid or false, name = e and e.name or nil, type = e and e.type or nil, active = e and e.valid and e.active or nil, direct_total = direct_total, segment_total = segment_total, boxes = boxes }
		end
		local function mk(label)
			local p = force.create_space_platform({ name = "fluid-lab-" .. label .. "-" .. game.tick, planet = "nauvis", starter_pack = "space-platform-starter-pack" })
			p.apply_starter_pack(); p.paused = false; force.set_surface_hidden(p.surface, false)
			local ox = 100 + p.index * 35; local oy = 100
			local tiles = {}; for x = -12, 12 do for y = -12, 12 do tiles[#tiles + 1] = { name = "space-platform-foundation", position = { ox + x, oy + y } } end end
			p.surface.set_tiles(tiles, true, false, true, false)
			return p, p.surface, ox, oy
		end
		local dirs = {
			{ name = "north", dir = defines.direction.north, in_pos = {0, 1}, out_pos = {0, -1}, tank = {0, -3} },
			{ name = "east", dir = defines.direction.east, in_pos = {-1, 0}, out_pos = {1, 0}, tank = {3, 0} },
			{ name = "south", dir = defines.direction.south, in_pos = {0, -1}, out_pos = {0, 1}, tank = {0, 3} },
			{ name = "west", dir = defines.direction.west, in_pos = {1, 0}, out_pos = {-1, 0}, tank = {-3, 0} },
		}
		local attempts = {}
		for _, d in ipairs(dirs) do
			local p, s, ox, oy = mk("r7pump-" .. d.name)
			local pump = s.create_entity({ name = "pump", position = { ox, oy }, direction = d.dir, force = force })
			local in_pipe = s.create_entity({ name = "pipe", position = { ox + d.in_pos[1], oy + d.in_pos[2] }, force = force })
			local out_pipe = s.create_entity({ name = "pipe", position = { ox + d.out_pos[1], oy + d.out_pos[2] }, force = force })
			local tank = s.create_entity({ name = "storage-tank", position = { ox + d.tank[1], oy + d.tank[2] }, force = force })
			tank.fluidbox[1] = { name = "heavy-oil", amount = 100, temperature = 25 }
			local read = read_entity("R7 pump setup " .. d.name, pump)
			local segmented = false
			for _, box in ipairs(read.boxes) do if box.segment_id then segmented = true end end
			attempts[#attempts + 1] = { direction = d.name, platform = p.index, segmented = segmented, pump = read, tank = read_entity("R7 tank setup " .. d.name, tank), in_pipe = read_entity("R7 in_pipe setup " .. d.name, in_pipe), out_pipe = read_entity("R7 out_pipe setup " .. d.name, out_pipe) }
			if segmented then
				storage.fluid_lab.records.r7pump = { platform = p.index, unit_number = pump.unit_number, direction = d.name }
				_G.__fluid_lab_read = read_entity
				return { success = true, rung = "R7-pump", selected = attempts[#attempts], attempts = attempts }
			end
		end
		return { success = false, rung = "R7-pump", attempts = attempts }
	`);
	if (!results.rungs.setup.success) {
		results.rungs.verdict = {
			success: true,
			rung: "R7-pump",
			verdict: "no activatable pump fluidbox with non-nil segment_id found",
			note: "Adjacent pipes/tanks reported segments; pump own fluidbox did not. This is recorded as negative domain data, not a harness failure.",
		};
	} else {
		const findPrefix = 'local rec=storage.fluid_lab.records.r7pump; local p=game.forces.player.platforms[rec.platform]; local e=nil; for _,c in pairs(p.surface.find_entities_filtered({})) do if c.unit_number==rec.unit_number then e=c end end; ';
		results.rungs.active_false = lua(`${findPrefix} e.active=false; return { success=true, rung="R7-pump", action="pump active=false", read=__fluid_lab_read("R7 pump active=false", e) }`);
		stepPaused(60);
		results.rungs.active_false_plus60 = lua(`${findPrefix} return { success=true, rung="R7-pump", action="pump active=false +60", read=__fluid_lab_read("R7 pump active=false +60", e) }`);
		results.rungs.active_true = lua(`${findPrefix} e.active=true; return { success=true, rung="R7-pump", action="pump active=true", read=__fluid_lab_read("R7 pump active=true", e) }`);
		results.rungs.write_inactive = lua(`${findPrefix} e.active=false; local before=__fluid_lab_read("R7 pump before inactive write", e); local ok,err=pcall(function() e.fluidbox[1]={name="heavy-oil",amount=50,temperature=25} end); local after_write=__fluid_lab_read("R7 pump after inactive write", e); e.active=true; local after_active=__fluid_lab_read("R7 pump after active=true from inactive write", e); return { success=true, rung="R7-pump", action="write while inactive", write={ok=ok,error=ok and nil or tostring(err)}, before=before, after_write=after_write, after_active=after_active }`);
	}
} catch (error) {
	results.errors.push(error.stack || error.message);
} finally {
	try { results.final_reset = resetLab(); } catch (error) { results.errors.push(`cleanup failed: ${error.stack || error.message}`); }
	results.finished = new Date().toISOString();
	appendFileSync(notebook, `\n\n## ${new Date().toISOString()} - R7 pump fluid-lab run (run-r7-pump.mjs)\n\n\`\`\`json\n${JSON.stringify(results, null, 2)}\n\`\`\`\n`);
	console.log(JSON.stringify(results, null, 2));
	if (results.errors.length || !results.final_reset?.zero_storage || !results.final_reset?.zero_surfaces) process.exitCode = 1;
}
