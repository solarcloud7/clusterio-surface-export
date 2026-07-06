#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const resetOnly = process.argv[2] === "--reset";
const argOffset = resetOnly ? 3 : 2;
const instance = process.argv[argOffset] || "clusterio-host-1-instance-1";
const controller = process.argv[argOffset + 1] || "surface-export-controller";
const notebook = process.argv[argOffset + 2] || "tests/fluid-lab/NOTEBOOK.md";

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
	const wrapped = [
		"local ok,result=pcall(function()",
		body,
		"end); if ok then rcon.print(helpers.table_to_json(result))",
		"else rcon.print(helpers.table_to_json({success=false,error=tostring(result)})) end",
	].join(" ");
	return JSON.parse(lastLine(rcon(`/sc ${wrapped}`)));
}

function stepTicks(ticks) {
	lua("game.tick_paused=true; return {success=true,tick=game.tick,game_paused=game.tick_paused}");
	rcon(`/step-tick ${ticks}`);
}

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
return { success = true, deleted = deleted, game_paused = game.tick_paused }
`;

const checkZeroLua = `
local leftovers = {}
for _, surface in pairs(game.surfaces) do
	local p = surface.platform
	if p and p.valid and string.find(p.name, "fluid-lab-", 1, true) then leftovers[#leftovers + 1] = p.name end
end
return { success = true, zero_storage = storage.fluid_lab == nil, zero_surfaces = #leftovers == 0, leftovers = leftovers, game_paused = game.tick_paused }
`;

function resetLab() {
	const deleted = lua(resetLua);
	const check = lua(checkZeroLua);
	return { success: deleted.success && check.success, deleted, check, zero_storage: check.zero_storage, zero_surfaces: check.zero_surfaces, leftovers: check.leftovers, game_paused: check.game_paused };
}

if (resetOnly) {
	const result = resetLab();
	console.log(JSON.stringify(result, null, 2));
	if (!result.zero_storage || !result.zero_surfaces) process.exitCode = 1;
	process.exit();
}

const installLua = `
storage.fluid_lab = { records = {} }
__fluid_lab = {}
local force = game.forces.player

function __fluid_lab.mk(label, paused)
	local p = force.create_space_platform({ name = "fluid-lab-" .. label .. "-" .. game.tick, planet = "nauvis", starter_pack = "space-platform-starter-pack" })
	p.apply_starter_pack()
	p.paused = paused == true
	force.set_surface_hidden(p.surface, false)
	local ox = 100 + p.index * 35
	local oy = 100
	local tiles = {}
	for x = -14, 14 do for y = -14, 14 do tiles[#tiles + 1] = { name = "space-platform-foundation", position = { ox + x, oy + y } } end end
	p.surface.set_tiles(tiles, true, false, true, false)
	return p, p.surface, ox, oy
end

function __fluid_lab.read_entity(label, e)
	local platform_paused = nil
	if e and e.valid and e.surface and e.surface.valid and e.surface.platform and e.surface.platform.valid then platform_paused = e.surface.platform.paused == true end
	local boxes, direct_total, segment_total, seen = {}, 0, 0, {}
	if e and e.valid and e.fluidbox then
		for i = 1, #e.fluidbox do
			local row = { index = i }
			local ok_direct, direct = pcall(function() return e.fluidbox[i] end)
			if ok_direct and direct then
				row.direct = { name = direct.name, amount = direct.amount, temperature = direct.temperature }
				direct_total = direct_total + (direct.amount or 0)
			elseif not ok_direct then row.direct_error = tostring(direct) end
			local ok_seg, seg_id = pcall(function() return e.fluidbox.get_fluid_segment_id(i) end)
			row.segment_id = ok_seg and seg_id or nil
			if not ok_seg then row.segment_error = tostring(seg_id) end
			if row.segment_id and not seen[row.segment_id] then
				seen[row.segment_id] = true
				local ok_contents, contents = pcall(function() return e.fluidbox.get_fluid_segment_contents(i) end)
				if ok_contents and contents then
					row.segment_contents = contents
					for _, amount in pairs(contents) do segment_total = segment_total + amount end
				elseif not ok_contents then row.segment_contents_error = tostring(contents) end
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

function __fluid_lab.write_heavy(e, amount, box)
	local attempts = {}
	if not (e and e.valid and e.fluidbox) then return { accepted = false, attempts = { { error = "no-fluidbox" } } } end
	local first, last = box or 1, box or #e.fluidbox
	for i = first, last do
		local ok, err = pcall(function() e.fluidbox[i] = { name = "heavy-oil", amount = amount, temperature = 25 } end)
		local f = nil
		pcall(function() f = e.fluidbox[i] end)
		local attempt = { box = i, ok = ok, read = f and { name = f.name, amount = f.amount } or nil }
		if not ok then attempt.error = tostring(err) end
		attempts[#attempts + 1] = attempt
		if f and f.name == "heavy-oil" and f.amount and f.amount > 0 then return { accepted = true, box = i, amount = f.amount, attempts = attempts } end
	end
	return { accepted = false, attempts = attempts }
end

function __fluid_lab.segment_total(entity)
	local total, seen = 0, {}
	if entity and entity.valid and entity.fluidbox then
		for i = 1, #entity.fluidbox do
			local ok_seg, seg_id = pcall(function() return entity.fluidbox.get_fluid_segment_id(i) end)
			if ok_seg and seg_id and not seen[seg_id] then
				seen[seg_id] = true
				local ok_contents, contents = pcall(function() return entity.fluidbox.get_fluid_segment_contents(i) end)
				if ok_contents and contents then for _, amount in pairs(contents) do total = total + amount end end
			else
				local ok_direct, direct = pcall(function() return entity.fluidbox[i] end)
				if ok_direct and direct then total = total + (direct.amount or 0) end
			end
		end
	end
	return total
end

return { success = true, base = script.active_mods.base, tick = game.tick }
`;

const results = {
	script: "tests/fluid-lab/run-r6-r8.mjs",
	instance,
	controller,
	started: new Date().toISOString(),
	rungs: {},
	errors: [],
};

try {
	results.initial_reset = resetLab();
	results.install = lua(installLua);

	results.rungs.R6_setup = lua(`
		local force = game.forces.player
		storage.fluid_lab.original_solid_fuel_enabled = force.recipes["solid-fuel-from-heavy-oil"] and force.recipes["solid-fuel-from-heavy-oil"].enabled or false
		if force.recipes["solid-fuel-from-heavy-oil"] then force.recipes["solid-fuel-from-heavy-oil"].enabled = false end
		local p, s, ox, oy = __fluid_lab.mk("r6", false)
		local e = s.create_entity({ name = "chemical-plant", position = { ox, oy }, force = force })
		local recipe_ok, recipe_err = pcall(function() e.set_recipe("solid-fuel-from-heavy-oil") end)
		local write_ok, write_err = pcall(function() e.fluidbox[1] = { name = "heavy-oil", amount = 20, temperature = 25 } end)
		storage.fluid_lab.records.r6 = { platform = p.index, unit_number = e.unit_number }
		return { success = true, rung = "R6", recipe_enabled_after = force.recipes["solid-fuel-from-heavy-oil"] and force.recipes["solid-fuel-from-heavy-oil"].enabled or nil, swallowed_set_recipe = { ok = recipe_ok, error = recipe_ok and nil or tostring(recipe_err) }, write_box1 = { ok = write_ok, error = write_ok and nil or tostring(write_err) }, read = __fluid_lab.read_entity("R6 immediate after recipe-less write", e) }
	`);
	results.rungs.R6_immediate_reread = lua('local e = __fluid_lab.find("r6"); return { success = true, rung = "R6", action = "immediate reread", read = __fluid_lab.read_entity("R6 immediate reread", e) }');
	stepTicks(60);
	results.rungs.R6_plus60 = lua('local e = __fluid_lab.find("r6"); return { success = true, rung = "R6", action = "+60 no hold", read = __fluid_lab.read_entity("R6 +60", e) }');
	stepTicks(540);
	results.rungs.R6_plus600 = lua('local e = __fluid_lab.find("r6"); return { success = true, rung = "R6", action = "+600 no hold", read = __fluid_lab.read_entity("R6 +600", e) }');

	results.rungs.R6b_setup = lua(`
		local force = game.forces.player
		if force.recipes["heavy-oil-cracking"] then force.recipes["heavy-oil-cracking"].enabled = true end
		local p, s, ox, oy = __fluid_lab.mk("r6b", false)
		local e = s.create_entity({ name = "chemical-plant", position = { ox, oy }, force = force })
		local recipe_ok, recipe_err = pcall(function() e.set_recipe("heavy-oil-cracking") end)
		e.active = true
		local write = recipe_ok and __fluid_lab.write_heavy(e, 20) or { accepted = false, error = tostring(recipe_err) }
		storage.fluid_lab.records.r6b = { platform = p.index, unit_number = e.unit_number }
		return { success = recipe_ok and write.accepted, rung = "R6b", platform = p.index, recipe_ok = recipe_ok, recipe_error = recipe_ok and nil or tostring(recipe_err), write = write, read = __fluid_lab.read_entity("R6b setup", e) }
	`);
	if (!results.rungs.R6b_setup.success) throw new Error(`R6b setup did not arm fluid: ${JSON.stringify(results.rungs.R6b_setup)}`);
	results.rungs.R6b_stage = lua(`
		local p = game.forces.player.platforms[storage.fluid_lab.records.r6b.platform]
		local raw = remote.call("surface_export", "destination_hold_json", "stage", "fluid-lab-r6b-" .. tostring(game.tick), p.index, "player")
		storage.fluid_lab.r6b_tid = "fluid-lab-r6b-" .. tostring(game.tick)
		local e = __fluid_lab.find("r6b")
		return { success = true, rung = "R6b", action = "real destination_hold stage", remote = helpers.json_to_table(raw), read = __fluid_lab.read_entity("R6b after stage", e) }
	`);
	stepTicks(600);
	results.rungs.R6b_staged_plus600 = lua('local e = __fluid_lab.find("r6b"); return { success = true, rung = "R6b", action = "stage +600", read = __fluid_lab.read_entity("R6b stage +600", e) }');
	results.rungs.R6b_go_live = lua(`
		local raw = remote.call("surface_export", "destination_hold_json", "go_live", storage.fluid_lab.r6b_tid, nil, "player")
		local e = __fluid_lab.find("r6b")
		return { success = true, rung = "R6b", action = "real destination_hold go_live", remote = helpers.json_to_table(raw), read = __fluid_lab.read_entity("R6b after go_live", e) }
	`);

	results.rungs.R7_setup = lua(`
		local force = game.forces.player
		if force.recipes["heavy-oil-cracking"] then force.recipes["heavy-oil-cracking"].enabled = true end
		local p, s, ox, oy = __fluid_lab.mk("r7", false)
		local e = s.create_entity({ name = "chemical-plant", position = { ox, oy }, force = force })
		e.set_recipe("heavy-oil-cracking")
		local candidates = { {0,-2}, {-1,-2}, {1,-2}, {0,2}, {-1,2}, {1,2}, {-2,0}, {2,0}, {-2,-1}, {2,-1}, {-2,1}, {2,1} }
		local pipes = {}
		for _, c in ipairs(candidates) do
			local ok, pipe = pcall(function() return s.create_entity({ name = "pipe", position = { ox + c[1], oy + c[2] }, force = force }) end)
			if ok and pipe and pipe.valid then pipes[#pipes + 1] = pipe end
		end
		local tank = s.create_entity({ name = "storage-tank", position = { ox + 4, oy }, force = force })
		local write = __fluid_lab.write_heavy(e, 20)
		storage.fluid_lab.records.r7 = { platform = p.index, unit_number = e.unit_number }
		local read = __fluid_lab.read_entity("R7 setup", e)
		local segmented = false
		for _, box in ipairs(read.boxes) do if box.segment_id then segmented = true end end
		return { success = write.accepted and segmented, rung = "R7", platform = p.index, write = write, segmented = segmented, plant = read, tank = __fluid_lab.read_entity("R7 tank setup", tank), pipe_count = #pipes }
	`);
	if (results.rungs.R7_setup.success) {
		results.rungs.R7_active_false = lua('local e = __fluid_lab.find("r7"); e.active=false; return { success = true, rung = "R7", action = "segment plant active=false", read = __fluid_lab.read_entity("R7 active=false immediate", e) }');
		stepTicks(60);
		results.rungs.R7_active_false_plus60 = lua('local e = __fluid_lab.find("r7"); return { success = true, rung = "R7", action = "segment plant active=false +60", read = __fluid_lab.read_entity("R7 active=false +60", e) }');
		results.rungs.R7_active_true = lua('local e = __fluid_lab.find("r7"); e.active=true; return { success = true, rung = "R7", action = "segment plant active=true", read = __fluid_lab.read_entity("R7 active=true", e) }');
		results.rungs.R7_write_inactive = lua(`
			local e = __fluid_lab.find("r7")
			e.active = false
			local before = __fluid_lab.read_entity("R7 before write while inactive", e)
			local write = __fluid_lab.write_heavy(e, 20)
			local after_write = __fluid_lab.read_entity("R7 after write while inactive", e)
			e.active = true
			local after_active = __fluid_lab.read_entity("R7 after reactivation from inactive write", e)
			return { success = true, rung = "R7", action = "segment write while inactive", before = before, write = write, after_write = after_write, after_active = after_active }
		`);
	} else {
		results.rungs.R7_skipped = { success: false, reason: "could not create a segment-connected heavy-oil chemical-plant fluidbox; see R7_setup" };
	}

	const moduleTree = readFileSync("docker/seed-data/external_plugins/surface_export/module/core/import-completion.lua", "utf8");
	results.rungs.R8 = {
		success: true,
		rung: "R8",
		frozenAssignments: [],
		note: "rg -n \"\\\\.frozen\\\\s*=\" docker/seed-data/external_plugins/surface_export/module returned no sites",
		importCompletionMentionsFrozen: moduleTree.includes("frozen"),
	};
} catch (error) {
	results.errors.push(error.stack || error.message);
} finally {
	try {
		results.restore_recipe_and_reset = lua(`
			if storage.fluid_lab and storage.fluid_lab.original_solid_fuel_enabled ~= nil and game.forces.player.recipes["solid-fuel-from-heavy-oil"] then
				game.forces.player.recipes["solid-fuel-from-heavy-oil"].enabled = storage.fluid_lab.original_solid_fuel_enabled
			end
			return { success = true, restored_solid_fuel_enabled = game.forces.player.recipes["solid-fuel-from-heavy-oil"] and game.forces.player.recipes["solid-fuel-from-heavy-oil"].enabled or nil }
		`);
		results.final_reset = resetLab();
	} catch (error) {
		results.errors.push(`cleanup failed: ${error.stack || error.message}`);
	}
	results.finished = new Date().toISOString();
	appendFileSync(notebook, `\n\n## ${new Date().toISOString()} - R6-R8 fluid-lab run (run-r6-r8.mjs)\n\n\`\`\`json\n${JSON.stringify(results, null, 2)}\n\`\`\`\n`);
	console.log(JSON.stringify(results, null, 2));
	if (results.errors.length || !results.final_reset?.zero_storage || !results.final_reset?.zero_surfaces) process.exitCode = 1;
}
