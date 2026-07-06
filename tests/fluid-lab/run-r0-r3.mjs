#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const resetOnly = process.argv[2] === "--reset";
const argOffset = resetOnly ? 3 : 2;
const instance = process.argv[argOffset] || "clusterio-host-1-instance-1";
const controller = process.argv[argOffset + 1] || "surface-export-controller";
const notebook = process.argv[argOffset + 2] || "tests/fluid-lab/NOTEBOOK.md";

function rcon(command) {
	const out = execFileSync("docker", [
		"exec", controller,
		"npx", "clusterioctl",
		"--log-level", "error",
		"instance", "send-rcon", instance, command,
		"--config", "/clusterio/tokens/config-control.json",
	], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	return out.trim();
}

function lastLine(text) {
	return String(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1) || "";
}

function lua(body) {
	const wrapped = [
		"local ok,result=pcall(function()",
		body,
		"end);",
		"if ok then rcon.print(helpers.table_to_json(result))",
		"else rcon.print(helpers.table_to_json({success=false,error=tostring(result)})) end",
	].join(" ");
	const raw = lastLine(rcon(`/sc ${wrapped}`));
	return JSON.parse(raw);
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
		local name = p.name
		local ok, err = pcall(function() game.delete_surface(surface) end)
		deleted[#deleted + 1] = { name = name, ok = ok, error = ok and nil or tostring(err) }
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
return { success = true, deleted = deleted, zero_storage = storage.fluid_lab == nil, leftovers = leftovers, zero_surfaces = #leftovers == 0, game_paused = game.tick_paused }
`;

const checkZeroLua = `
local leftovers = {}
for _, surface in pairs(game.surfaces) do
	local p = surface.platform
	if p and p.valid and string.find(p.name, "fluid-lab-", 1, true) then leftovers[#leftovers + 1] = p.name end
end
return { success = true, zero_storage = storage.fluid_lab == nil, leftovers = leftovers, zero_surfaces = #leftovers == 0, game_paused = game.tick_paused }
`;

const installLua = `
storage.fluid_lab = { records = {} }
__fluid_lab = {}
local force = game.forces.player
if force.recipes["heavy-oil-cracking"] then force.recipes["heavy-oil-cracking"].enabled = true end

function __fluid_lab.mk(label, paused)
	local p = force.create_space_platform({ name = "fluid-lab-" .. label .. "-" .. game.tick, planet = "nauvis", starter_pack = "space-platform-starter-pack" })
	p.apply_starter_pack()
	p.paused = paused == true
	force.set_surface_hidden(p.surface, false)
	local ox = 100 + p.index * 35
	local oy = 100
	local tiles = {}
	for x = -10, 12 do for y = -10, 12 do tiles[#tiles + 1] = { name = "space-platform-foundation", position = { ox + x, oy + y } } end end
	p.surface.set_tiles(tiles, true, false, true, false)
	return p, p.surface, ox, oy
end

function __fluid_lab.read_entity(label, e)
	local platform_paused = nil
	if e and e.valid and e.surface and e.surface.valid and e.surface.platform and e.surface.platform.valid then
		platform_paused = e.surface.platform.paused == true
	end
	local boxes = {}
	local direct_total = 0
	local segment_total = 0
	local seen = {}
	if e and e.valid and e.fluidbox then
		for i = 1, #e.fluidbox do
			local row = { index = i }
			local ok_direct, direct = pcall(function() return e.fluidbox[i] end)
			if ok_direct and direct then
				row.direct = { name = direct.name, amount = direct.amount, temperature = direct.temperature }
				direct_total = direct_total + (direct.amount or 0)
			else
				row.direct = nil
				row.direct_error = ok_direct and nil or tostring(direct)
			end
			local ok_seg, seg_id = pcall(function() return e.fluidbox.get_fluid_segment_id(i) end)
			row.segment_id = ok_seg and seg_id or nil
			row.segment_error = ok_seg and nil or tostring(seg_id)
			if row.segment_id and not seen[row.segment_id] then
				seen[row.segment_id] = true
				local ok_contents, contents = pcall(function() return e.fluidbox.get_fluid_segment_contents(i) end)
				if ok_contents and contents then
					row.segment_contents = contents
					for _, amount in pairs(contents) do segment_total = segment_total + amount end
				else
					row.segment_contents = nil
					row.segment_contents_error = ok_contents and nil or tostring(contents)
				end
			end
			boxes[#boxes + 1] = row
		end
	end
	return {
		label = label,
		tick = game.tick,
		game_paused = game.tick_paused == true,
		platform_paused = platform_paused,
		valid = e and e.valid or false,
		name = e and e.name or nil,
		type = e and e.type or nil,
		active = e and e.valid and e.active or nil,
		direct_total = direct_total,
		segment_total = segment_total,
		boxes = boxes,
	}
end

function __fluid_lab.write_any(e, amount, only)
	local fluids = only and { only } or { "heavy-oil", "water", "crude-oil", "steam", "thruster-fuel", "thruster-oxidizer" }
	local attempts = {}
	if not (e and e.valid and e.fluidbox) then return { accepted = false, attempts = { { error = "no-fluidbox" } } } end
	for i = 1, #e.fluidbox do
		for _, fluid in ipairs(fluids) do
			local ok, err = pcall(function() e.fluidbox[i] = { name = fluid, amount = amount, temperature = 25 } end)
			local f = nil
			pcall(function() f = e.fluidbox[i] end)
			attempts[#attempts + 1] = { box = i, fluid = fluid, ok = ok, error = ok and nil or tostring(err), read = f and { name = f.name, amount = f.amount } or nil }
			if f and f.name == fluid and f.amount and f.amount > 0 then
				return { accepted = true, box = i, fluid = fluid, amount = f.amount, attempts = attempts }
			end
		end
	end
	return { accepted = false, attempts = attempts }
end

function __fluid_lab.find(label)
	local rec = storage.fluid_lab.records[label]
	if not rec then return nil end
	local p = force.platforms[rec.platform]
	if not (p and p.valid) then return nil end
	for _, e in pairs(p.surface.find_entities_filtered({})) do
		if e.unit_number == rec.unit_number then return e end
	end
	return nil
end

function __fluid_lab.plant(label, amount, platform_paused)
	local p, s, ox, oy = __fluid_lab.mk(label, platform_paused)
	local e = s.create_entity({ name = "chemical-plant", position = { ox, oy }, force = force })
	local recipe_ok, recipe_err = pcall(function() e.set_recipe("heavy-oil-cracking") end)
	e.active = true
	local write = recipe_ok and __fluid_lab.write_any(e, amount, "heavy-oil") or { accepted = false, error = tostring(recipe_err) }
	storage.fluid_lab.records[label] = { platform = p.index, unit_number = e.unit_number }
	return { platform = p.index, unit_number = e.unit_number, recipe_ok = recipe_ok, recipe_error = recipe_ok and nil or tostring(recipe_err), write = write, read = __fluid_lab.read_entity(label .. ":setup", e) }
end

return { success = true, base = script.active_mods.base, tick = game.tick }
`;

const results = {
	script: "tests/fluid-lab/run-r0-r3.mjs",
	instance,
	controller,
	started: new Date().toISOString(),
	rungs: {},
	errors: [],
};

function requireFluid(label, setup) {
	const amount = Number(setup?.read?.direct_total || 0) + Number(setup?.read?.segment_total || 0);
	if (!setup?.recipe_ok || !setup?.write?.accepted || amount <= 0) {
		throw new Error(`${label} write-acceptance failed: ${JSON.stringify(setup)}`);
	}
}

function resetLab() {
	const deleted = lua(resetLua);
	const check = lua(checkZeroLua);
	return {
		success: deleted.success && check.success,
		deleted,
		check,
		zero_storage: check.zero_storage,
		zero_surfaces: check.zero_surfaces,
		leftovers: check.leftovers,
		game_paused: check.game_paused,
	};
}

if (resetOnly) {
	const result = resetLab();
	console.log(JSON.stringify(result, null, 2));
	if (!result.zero_storage || !result.zero_surfaces) process.exitCode = 1;
	process.exit();
}
try {
	results.initial_reset = resetLab();
	results.install = lua(installLua);

	results.rungs.R0 = lua(`
		local F = __fluid_lab
		local force = game.forces.player
		local p, s, ox, oy = F.mk("r0", false)
		local specs = {
			{ label = "chemical-plant", name = "chemical-plant", dx = 0, dy = 0, recipe = "heavy-oil-cracking", amount = 20 },
			{ label = "pump", name = "pump", dx = 3, dy = 0, amount = 30 },
			{ label = "boiler", name = "boiler", dx = 6, dy = 0, amount = 30 },
			{ label = "thruster", name = "thruster", dx = 9, dy = 0, amount = 30 },
			{ label = "storage-tank", name = "storage-tank", dx = 0, dy = 5, amount = 30 },
			{ label = "pipe", name = "pipe", dx = 4, dy = 5, amount = 30 },
		}
		local rows = {}
		for _, spec in ipairs(specs) do
			local ok, e = pcall(function() return s.create_entity({ name = spec.name, position = { ox + spec.dx, oy + spec.dy }, force = force }) end)
			local row = { label = spec.label, create_ok = ok, create_error = ok and nil or tostring(e) }
			if ok and e and e.valid then
				if spec.recipe then
					local recipe_ok, recipe_err = pcall(function() e.set_recipe(spec.recipe) end)
					row.recipe_ok = recipe_ok
					row.recipe_error = recipe_ok and nil or tostring(recipe_err)
				end
				e.active = true
				row.write = F.write_any(e, spec.amount)
				row.read = F.read_entity("R0:" .. spec.label, e)
			end
			rows[#rows + 1] = row
		end
		return { success = true, rung = "R0", platform = p.index, rows = rows }
	`);
	const r0Plant = results.rungs.R0.rows.find(row => row.label === "chemical-plant");
	requireFluid("R0 chemical-plant", { recipe_ok: r0Plant.recipe_ok, write: r0Plant.write, read: r0Plant.read });

	results.rungs.R1_active_setup = lua('return { success = true, rung = "R1", case = "active_false", setup = __fluid_lab.plant("r1_active", 20, false) }');
	requireFluid("R1 active setup", results.rungs.R1_active_setup.setup);
	results.rungs.R1_active_set_false = lua('local e = __fluid_lab.find("r1_active"); e.active = false; return { success = true, rung = "R1", case = "active_false", action = "active=false", read = __fluid_lab.read_entity("R1 active=false immediate", e) }');
	results.rungs.R1_active_immediate = lua('local e = __fluid_lab.find("r1_active"); return { success = true, rung = "R1", case = "active_false", action = "immediate reread", read = __fluid_lab.read_entity("R1 active=false immediate reread", e) }');
	stepTicks(60);
	results.rungs.R1_active_plus60 = lua('local e = __fluid_lab.find("r1_active"); return { success = true, rung = "R1", case = "active_false", action = "+60", read = __fluid_lab.read_entity("R1 active=false +60", e) }');
	results.rungs.R1_active_set_true = lua('local e = __fluid_lab.find("r1_active"); e.active = true; return { success = true, rung = "R1", case = "active_false", action = "active=true", read = __fluid_lab.read_entity("R1 active=true immediate", e) }');
	stepTicks(60);
	results.rungs.R1_active_true_plus60 = lua('local e = __fluid_lab.find("r1_active"); return { success = true, rung = "R1", case = "active_false", action = "active=true +60", read = __fluid_lab.read_entity("R1 active=true +60", e) }');

	results.rungs.R1_frozen_setup = lua('return { success = true, rung = "R1", case = "frozen_true", setup = __fluid_lab.plant("r1_frozen", 20, false) }');
	requireFluid("R1 frozen setup", results.rungs.R1_frozen_setup.setup);
	results.rungs.R1_frozen_set_true = lua('local e = __fluid_lab.find("r1_frozen"); local ok, err = pcall(function() e.frozen = true end); return { success = ok, error = ok and nil or tostring(err), rung = "R1", case = "frozen_true", action = "frozen=true", read = __fluid_lab.read_entity("R1 frozen=true immediate", e) }');
	stepTicks(60);
	results.rungs.R1_frozen_plus60 = lua('local e = __fluid_lab.find("r1_frozen"); return { success = true, rung = "R1", case = "frozen_true", action = "frozen +60", read = __fluid_lab.read_entity("R1 frozen=true +60", e) }');
	results.rungs.R1_frozen_set_false = lua('local e = __fluid_lab.find("r1_frozen"); local ok, err = pcall(function() e.frozen = false end); return { success = ok, error = ok and nil or tostring(err), rung = "R1", case = "frozen_true", action = "frozen=false", read = __fluid_lab.read_entity("R1 frozen=false immediate", e) }');
	stepTicks(60);
	results.rungs.R1_frozen_false_plus60 = lua('local e = __fluid_lab.find("r1_frozen"); return { success = true, rung = "R1", case = "frozen_true", action = "unfrozen +60", read = __fluid_lab.read_entity("R1 frozen=false +60", e) }');

	results.rungs.R2 = lua(`
		local F = __fluid_lab
		local p, s, ox, oy = F.mk("r2", false)
		local e = s.create_entity({ name = "chemical-plant", position = { ox, oy }, force = game.forces.player })
		local recipe_ok, recipe_err = pcall(function() e.set_recipe("heavy-oil-cracking") end)
		e.active = false
		local before = F.read_entity("R2 before write inactive", e)
		local write = F.write_any(e, 20, "heavy-oil")
		local after_write = F.read_entity("R2 after write inactive", e)
		e.active = true
		local after_active = F.read_entity("R2 after active=true", e)
		return { success = true, rung = "R2", platform = p.index, recipe_ok = recipe_ok, recipe_error = recipe_ok and nil or tostring(recipe_err), before = before, write = write, after_write = after_write, after_active = after_active }
	`);

	results.rungs.R3_setup = lua('return { success = true, rung = "R3", setup = __fluid_lab.plant("r3", 20, true) }');
	requireFluid("R3 setup", results.rungs.R3_setup.setup);
	stepTicks(600);
	results.rungs.R3_plus600 = lua('local e = __fluid_lab.find("r3"); return { success = true, rung = "R3", action = "platform paused +600", read = __fluid_lab.read_entity("R3 paused +600", e) }');
	results.rungs.R3_unpause = lua('local rec = storage.fluid_lab.records.r3; local p = game.forces.player.platforms[rec.platform]; p.paused = false; local e = __fluid_lab.find("r3"); return { success = true, rung = "R3", action = "platform unpaused", read = __fluid_lab.read_entity("R3 after unpause", e) }');
} catch (error) {
	results.errors.push(error.stack || error.message);
} finally {
	try {
		results.final_reset = resetLab();
	} catch (error) {
		results.errors.push(`cleanup failed: ${error.stack || error.message}`);
	}
	results.finished = new Date().toISOString();
	appendFileSync(notebook, `\n\n## ${new Date().toISOString()} - R0-R3 fluid-lab run (run-r0-r3.mjs)\n\n\`\`\`json\n${JSON.stringify(results, null, 2)}\n\`\`\`\n`);
	console.log(JSON.stringify(results, null, 2));
	if (results.errors.length || !results.final_reset?.zero_storage || !results.final_reset?.zero_surfaces) process.exitCode = 1;
}
