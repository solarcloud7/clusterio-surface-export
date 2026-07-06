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

function lastLine(text) {
	return String(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1) || "";
}

function lua(body) {
	const wrapped = `local ok,result=pcall(function() ${body} end); if ok then rcon.print(helpers.table_to_json(result)) else rcon.print(helpers.table_to_json({success=false,error=tostring(result)})) end`;
	return JSON.parse(lastLine(rcon(`/sc ${wrapped}`)));
}

function stepPaused(ticks) {
	lua("game.tick_paused = true; return {success=true,tick=game.tick,game_paused=game.tick_paused}");
	rcon(`/step-tick ${ticks}`);
	lua("game.tick_paused = true; return {success=true,tick=game.tick,game_paused=game.tick_paused}");
}

function stepUnpaused(ticks) {
	lua("game.tick_paused = false; return {success=true,tick=game.tick,game_paused=game.tick_paused}");
	rcon(`/step-tick ${ticks}`);
}

const helpersLua = `
storage.fluid_lab = storage.fluid_lab or { records = {} }
__fluid_lab = {}
local force = game.forces.player
function __fluid_lab.mk(label)
	local p = force.create_space_platform({ name = "fluid-lab-" .. label .. "-" .. game.tick, planet = "nauvis", starter_pack = "space-platform-starter-pack" })
	p.apply_starter_pack()
	p.paused = false
	force.set_surface_hidden(p.surface, false)
	local ox = 100 + p.index * 35
	local oy = 100
	local tiles = {}
	for x = -10, 10 do for y = -10, 10 do tiles[#tiles + 1] = { name = "space-platform-foundation", position = { ox + x, oy + y } } end end
	p.surface.set_tiles(tiles, true, false, true, false)
	return p, p.surface, ox, oy
end
function __fluid_lab.read(label, e)
	local boxes, direct_total, segment_total, seen = {}, 0, 0, {}
	local platform_paused = nil
	if e and e.valid and e.surface and e.surface.valid and e.surface.platform and e.surface.platform.valid then platform_paused = e.surface.platform.paused == true end
	if e and e.valid and e.fluidbox then
		for i = 1, #e.fluidbox do
			local row = { index = i }
			local ok_direct, direct = pcall(function() return e.fluidbox[i] end)
			if ok_direct and direct then row.direct = { name = direct.name, amount = direct.amount, temperature = direct.temperature }; direct_total = direct_total + (direct.amount or 0) end
			local ok_seg, seg_id = pcall(function() return e.fluidbox.get_fluid_segment_id(i) end)
			row.segment_id = ok_seg and seg_id or nil
			if row.segment_id and not seen[row.segment_id] then
				seen[row.segment_id] = true
				local ok_contents, contents = pcall(function() return e.fluidbox.get_fluid_segment_contents(i) end)
				if ok_contents and contents then row.segment_contents = contents; for _, amount in pairs(contents) do segment_total = segment_total + amount end end
			end
			boxes[#boxes + 1] = row
		end
	end
	return { label = label, tick = game.tick, game_paused = game.tick_paused == true, platform_paused = platform_paused, valid = e and e.valid or false, name = e and e.name or nil, type = e and e.type or nil, active = e and e.valid and e.active or nil, direct_total = direct_total, segment_total = segment_total, boxes = boxes }
end
function __fluid_lab.find(label)
	local rec = storage.fluid_lab.records[label]
	if not rec then return nil end
	local p = force.platforms[rec.platform]
	if not (p and p.valid) then return nil end
	for _, e in pairs(p.surface.find_entities_filtered({})) do if e.unit_number == rec.unit_number then return e end end
	return nil
end
return { success = true, tick = game.tick, game_paused = game.tick_paused == true }
`;

const resetLua = `
local deleted = {}
for _, surface in pairs(game.surfaces) do
	local p = surface.platform
	if p and p.valid and string.find(p.name, "fluid-lab-", 1, true) then
		local row = { name = p.name }
		local ok, err = pcall(function() game.delete_surface(surface) end)
		row.ok = ok
		if not ok then row.error = tostring(err) end
		deleted[#deleted + 1] = row
	end
end
storage.fluid_lab = nil
__fluid_lab = nil
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
const results = { script: "tests/fluid-lab/run-r9.mjs", started: new Date().toISOString(), rungs: {}, errors: [] };

try {
	results.initial_reset = resetLab();
	results.install = lua(helpersLua);
	results.rungs.setup = lua(`
		game.tick_paused = true
		local force = game.forces.player
		if force.recipes["heavy-oil-cracking"] then force.recipes["heavy-oil-cracking"].enabled = true end
		local p, s, ox, oy = __fluid_lab.mk("r9")
		local e = s.create_entity({ name = "chemical-plant", position = { ox, oy }, force = force })
		local recipe_ok, recipe_err = pcall(function() e.set_recipe("heavy-oil-cracking") end)
		e.active = true
		local attempts = {}
		local accepted = false
		for i = 1, #e.fluidbox do
			local ok, err = pcall(function() e.fluidbox[i] = { name = "heavy-oil", amount = 20, temperature = 25 } end)
			local f = e.fluidbox[i]
			attempts[#attempts + 1] = { box = i, ok = ok, error = ok and nil or tostring(err), read = f and { name = f.name, amount = f.amount } or nil }
			if f and f.name == "heavy-oil" and f.amount and f.amount > 0 then accepted = true; break end
		end
		storage.fluid_lab.records.r9 = { platform = p.index, unit_number = e.unit_number, transfer_id = "fluid-lab-r9-" .. tostring(game.tick) }
		return { success = recipe_ok and accepted, rung = "R9", action = "fixture under paused game", recipe_ok = recipe_ok, recipe_error = recipe_ok and nil or tostring(recipe_err), attempts = attempts, read = __fluid_lab.read("R9 pre-read", e) }
	`);
	if (!results.rungs.setup.success) throw new Error(`R9 setup failed to arm fluid: ${JSON.stringify(results.rungs.setup)}`);
	results.rungs.stage = lua(`
		local rec = storage.fluid_lab.records.r9
		local p = game.forces.player.platforms[rec.platform]
		local raw = remote.call("surface_export", "destination_hold_json", "stage", rec.transfer_id, p.index, "player")
		local e = __fluid_lab.find("r9")
		return { success = true, rung = "R9", action = "real stage", remote = helpers.json_to_table(raw), read = __fluid_lab.read("R9 after stage", e) }
	`);
	stepPaused(600);
	results.rungs.staged_plus600 = lua('local e = __fluid_lab.find("r9"); return { success = true, rung = "R9", action = "stage +600 ensure-paused", read = __fluid_lab.read("R9 stage +600", e) }');
	results.rungs.go_live = lua(`
		local rec = storage.fluid_lab.records.r9
		local raw = remote.call("surface_export", "destination_hold_json", "go_live", rec.transfer_id, nil, "player")
		local e = __fluid_lab.find("r9")
		return { success = true, rung = "R9", action = "real go_live", remote = helpers.json_to_table(raw), read = __fluid_lab.read("R9 after go_live", e) }
	`);
	stepPaused(60);
	results.rungs.go_live_plus60 = lua('local e = __fluid_lab.find("r9"); return { success = true, rung = "R9", action = "go_live +60 ensure-paused", read = __fluid_lab.read("R9 go_live +60", e) }');
	stepUnpaused(120);
	results.rungs.unpaused_plus120 = lua('local e = __fluid_lab.find("r9"); return { success = true, rung = "R9", action = "unpaused +120 staleness check", read = __fluid_lab.read("R9 unpaused +120", e) }');
} catch (error) {
	results.errors.push(error.stack || error.message);
} finally {
	try { results.final_reset = resetLab(); } catch (error) { results.errors.push(`cleanup failed: ${error.stack || error.message}`); }
	results.finished = new Date().toISOString();
	appendFileSync(notebook, `\n\n## ${new Date().toISOString()} - R9 fluid-lab run (run-r9.mjs)\n\n\`\`\`json\n${JSON.stringify(results, null, 2)}\n\`\`\`\n`);
	console.log(JSON.stringify(results, null, 2));
	if (results.errors.length || !results.final_reset?.zero_storage || !results.final_reset?.zero_surfaces) process.exitCode = 1;
}
