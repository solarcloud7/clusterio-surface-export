#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { evaluateHoldCompletenessResults } from "./evaluate.mjs";

const resetOnly = process.argv[2] === "--reset";
const argOffset = resetOnly ? 3 : 2;
const instance = process.argv[argOffset] || "clusterio-host-1-instance-1";
const controller = process.argv[argOffset + 1] || "surface-export-controller";
const notebook = process.argv[argOffset + 2] || "tests/hold-completeness-lab/NOTEBOOK.md";

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
		"end);",
		"if ok then rcon.print(helpers.table_to_json(result))",
		"else rcon.print(helpers.table_to_json({success=false,error=tostring(result)})) end",
	].join(" ");
	return JSON.parse(lastLine(rcon(`/sc ${wrapped}`)));
}

function stepTicks(ticks) {
	lua("game.tick_paused = true; return { success = true, tick = game.tick, game_paused = game.tick_paused }");
	rcon(`/step-tick ${ticks}`);
	return lua("game.tick_paused = true; return { success = true, tick = game.tick, game_paused = game.tick_paused }");
}

const resetLua = `
local deleted = {}
for _, surface in pairs(game.surfaces) do
	local p = surface.platform
	if p and p.valid and string.find(p.name, "hold-completeness-lab-", 1, true) then
		local row = { name = p.name }
		local ok, err = pcall(function() game.delete_surface(surface) end)
		row.ok = ok
		if not ok then row.error = tostring(err) end
		deleted[#deleted + 1] = row
	end
end
if storage.destination_holds then
	for transfer_id, _ in pairs(storage.destination_holds) do
		if type(transfer_id) == "string" and string.find(transfer_id, "^hold%-completeness%-lab%-") then
			pcall(function() remote.call("surface_export", "destination_hold", "discard", transfer_id) end)
			storage.destination_holds[transfer_id] = nil
		end
	end
end
storage.hold_completeness_lab = nil
__hold_completeness_lab = nil
game.tick_paused = false
local leftovers = {}
for _, surface in pairs(game.surfaces) do
	local p = surface.platform
	if p and p.valid and string.find(p.name, "hold-completeness-lab-", 1, true) then leftovers[#leftovers + 1] = p.name end
end
return { success = true, deleted = deleted, zero_storage = storage.hold_completeness_lab == nil, zero_surfaces = #leftovers == 0, leftovers = leftovers, game_paused = game.tick_paused }
`;

const installLua = `
storage.hold_completeness_lab = { records = {} }
__hold_completeness_lab = {}
local H = __hold_completeness_lab
local force = game.forces.player

local function proto_item(name)
	if prototypes and prototypes.item and prototypes.item[name] then return prototypes.item[name] end
	if game.item_prototypes and game.item_prototypes[name] then return game.item_prototypes[name] end
	return nil
end

function H.mk(label)
	local p = force.create_space_platform({ name = "hold-completeness-lab-" .. label .. "-" .. game.tick, planet = "nauvis", starter_pack = "space-platform-starter-pack" })
	p.apply_starter_pack()
	p.paused = false
	force.set_surface_hidden(p.surface, false)
	local ox = 100 + p.index * 40
	local oy = 100
	local tiles = {}
	for x = -12, 12 do for y = -12, 12 do tiles[#tiles + 1] = { name = "space-platform-foundation", position = { ox + x, oy + y } } end end
	p.surface.set_tiles(tiles, true, false, true, false)
	return p, p.surface, ox, oy
end

function H.stage(label, platform)
	local transfer_id = "hold-completeness-lab-" .. label .. "-" .. tostring(game.tick)
	local raw = remote.call("surface_export", "destination_hold_json", "stage", transfer_id, platform.index, "player")
	return transfer_id, helpers.json_to_table(raw)
end


function H.discard(transfer_id)
	local raw = remote.call("surface_export", "destination_hold_json", "discard", transfer_id, nil, "player")
	return helpers.json_to_table(raw)
end

function H.find_platform(label)
	local rec = storage.hold_completeness_lab.records[label]
	if not rec then return nil end
	local p = force.platforms[rec.platform]
	if p and p.valid then return p end
	return nil
end

function H.find_entity(label, key)
	local rec = storage.hold_completeness_lab.records[label]
	local p = H.find_platform(label)
	if not (rec and p) then return nil end
	local wanted = rec[key or "unit_number"]
	for _, e in pairs(p.surface.find_entities_filtered({})) do
		if e.unit_number == wanted then return e end
	end
	return nil
end

function H.read_stack(label, e)
	local inv = e and e.valid and e.get_inventory(defines.inventory.chest) or nil
	local stack = inv and inv[1] or nil
	local row = { label = label, tick = game.tick, game_paused = game.tick_paused == true, valid = e and e.valid or false, entity = e and e.name or nil }
	if e and e.valid and e.surface and e.surface.platform and e.surface.platform.valid then row.platform_paused = e.surface.platform.paused == true end
	if stack and stack.valid_for_read then
		row.stack = { name = stack.name, count = stack.count }
		local ok_spoil, spoil = pcall(function() return stack.spoil_percent end)
		row.stack.spoil_percent = ok_spoil and spoil or nil
		row.stack.spoil_error = ok_spoil and nil or tostring(spoil)
	else
		row.stack = nil
	end
	return row
end

function H.spoilable_item()
	local candidates = { "yumako", "jellynut", "bioflux", "agricultural-science-pack", "nutrients", "pentapod-egg" }
	for _, name in ipairs(candidates) do
		local proto = proto_item(name)
		if proto then return name end
	end
	return nil
end

function H.setup_spoilage()
	local item = H.spoilable_item()
	if not item then return { status = "unconstructible", reason = "no spoilable item candidate exists", tick = game.tick } end
	local live, live_surface, lx, ly = H.mk("spoilage-live")
	local held, held_surface, hx, hy = H.mk("spoilage-held")
	local live_chest = live_surface.create_entity({ name = "steel-chest", position = { lx, ly }, force = force })
	local held_chest = held_surface.create_entity({ name = "steel-chest", position = { hx, hy }, force = force })
	local function seed(chest)
		local inv = chest.get_inventory(defines.inventory.chest)
		local ok_stack, stack_err = pcall(function() inv[1].set_stack({ name = item, count = 1 }) end)
		local ok_spoil, spoil_err = pcall(function() inv[1].spoil_percent = 0.95 end)
		return { ok_stack = ok_stack, stack_error = ok_stack and nil or tostring(stack_err), ok_spoil = ok_spoil, spoil_error = ok_spoil and nil or tostring(spoil_err) }
	end
	local live_seed = seed(live_chest)
	local held_seed = seed(held_chest)
	local transfer_id, stage = H.stage("spoilage", held)
	storage.hold_completeness_lab.records.spoilage_live = { platform = live.index, unit_number = live_chest.unit_number }
	storage.hold_completeness_lab.records.spoilage_held = { platform = held.index, unit_number = held_chest.unit_number, transfer_id = transfer_id }
	return { status = "setup", item = item, transfer_id = transfer_id, stage = stage, live_seed = live_seed, held_seed = held_seed, live_before = H.read_stack("spoilage live before", live_chest), held_before = H.read_stack("spoilage held before", held_chest) }
end

function H.read_spoilage()
	local live = H.find_entity("spoilage_live")
	local held = H.find_entity("spoilage_held")
	return { live_after = H.read_stack("spoilage live after", live), held_after = H.read_stack("spoilage held after", held) }
end

function H.setup_damage()
	local asteroid_names = { "small-metallic-asteroid", "medium-metallic-asteroid", "small-carbonic-asteroid", "small-oxide-asteroid" }
	local live, live_surface, lx, ly = H.mk("damage-live")
	local held, held_surface, hx, hy = H.mk("damage-held")
	local live_target = live_surface.create_entity({ name = "steel-chest", position = { lx, ly }, force = force })
	local held_target = held_surface.create_entity({ name = "steel-chest", position = { hx, hy }, force = force })
	local asteroid_name = nil
	local live_asteroid = nil
	local held_asteroid = nil
	local errors = {}
	for _, name in ipairs(asteroid_names) do
		local ok1, a1 = pcall(function() return live_surface.create_entity({ name = name, position = { lx - 2, ly }, force = "neutral" }) end)
		local ok2, a2 = pcall(function() return held_surface.create_entity({ name = name, position = { hx - 2, hy }, force = "neutral" }) end)
		if ok1 and ok2 and a1 and a2 then asteroid_name = name; live_asteroid = a1; held_asteroid = a2; break end
		errors[#errors + 1] = { name = name, live_ok = ok1, live_error = ok1 and nil or tostring(a1), held_ok = ok2, held_error = ok2 and nil or tostring(a2) }
	end
	if not asteroid_name then return { status = "unconstructible", reason = "could not create asteroid specimen", errors = errors, tick = game.tick } end
	local transfer_id, stage = H.stage("damage", held)
	storage.hold_completeness_lab.records.damage_live = { platform = live.index, unit_number = live_target.unit_number, asteroid_unit_number = live_asteroid.unit_number }
	storage.hold_completeness_lab.records.damage_held = { platform = held.index, unit_number = held_target.unit_number, asteroid_unit_number = held_asteroid.unit_number, transfer_id = transfer_id }
	return { status = "setup", asteroid = asteroid_name, transfer_id = transfer_id, stage = stage, live_before = H.read_health("damage live before", live_target, live_asteroid), held_before = H.read_health("damage held before", held_target, held_asteroid) }
end

function H.read_health(label, target, asteroid)
	local row = { label = label, tick = game.tick, game_paused = game.tick_paused == true, target_valid = target and target.valid or false, asteroid_valid = asteroid and asteroid.valid or false }
	if target and target.valid then row.target_health = target.health; if target.surface and target.surface.platform and target.surface.platform.valid then row.platform_paused = target.surface.platform.paused == true end end
	if asteroid and asteroid.valid then row.asteroid_health = asteroid.health; row.asteroid_position = { x = asteroid.position.x, y = asteroid.position.y } end
	return row
end

function H.read_damage()
	local live = H.find_entity("damage_live")
	local held = H.find_entity("damage_held")
	local live_rec = storage.hold_completeness_lab.records.damage_live
	local held_rec = storage.hold_completeness_lab.records.damage_held
	local live_asteroid = nil
	local held_asteroid = nil
	for _, e in pairs(H.find_platform("damage_live").surface.find_entities_filtered({})) do if e.unit_number == live_rec.asteroid_unit_number then live_asteroid = e end end
	for _, e in pairs(H.find_platform("damage_held").surface.find_entities_filtered({})) do if e.unit_number == held_rec.asteroid_unit_number then held_asteroid = e end end
	return { live_after = H.read_health("damage live after", live, live_asteroid), held_after = H.read_health("damage held after", held, held_asteroid) }
end

function H.setup_cargo_pods()
	-- descending-pod overflow branch: fill hub inventory, put cargo in pods, and verify held pods do not land/spill while held.
	local live, live_surface, lx, ly = H.mk("cargo-live")
	local held, held_surface, hx, hy = H.mk("cargo-held")
	local function find_hub(surface)
		for _, e in pairs(surface.find_entities_filtered({ name = "space-platform-hub" })) do return e end
		return nil
	end
	local live_hub = find_hub(live_surface)
	local held_hub = find_hub(held_surface)
	local pod_errors = {}
	local function seed_hub(hub)
		local inv = hub and hub.valid and hub.get_inventory(defines.inventory.hub_main) or nil
		if not inv then return false end
		for i = 1, #inv do inv[i].set_stack({ name = "iron-plate", count = 100 }) end
		return true
	end
	local function make_pod(surface, x, y)
		local ok, pod = pcall(function() return surface.create_entity({ name = "cargo-pod", position = { x, y }, force = force }) end)
		if not (ok and pod) then return nil, ok and "nil-pod" or tostring(pod) end
		local inv = pod.get_inventory(defines.inventory.cargo_unit)
		if inv then pcall(function() inv.insert({ name = "copper-plate", count = 100 }) end) end
		return pod, nil
	end
	local live_full = seed_hub(live_hub)
	local held_full = seed_hub(held_hub)
	local live_pod, live_err = make_pod(live_surface, lx + 2, ly)
	local held_pod, held_err = make_pod(held_surface, hx + 2, hy)
	if live_err or held_err then
		return { status = "unconstructible", reason = "could not create cargo-pod specimen", live_error = live_err, held_error = held_err, tick = game.tick }
	end
	local transfer_id, stage = H.stage("cargo", held)
	storage.hold_completeness_lab.records.cargo_live = { platform = live.index, unit_number = live_pod.unit_number, hub_unit_number = live_hub and live_hub.unit_number or nil }
	storage.hold_completeness_lab.records.cargo_held = { platform = held.index, unit_number = held_pod.unit_number, hub_unit_number = held_hub and held_hub.unit_number or nil, transfer_id = transfer_id }
	return { status = "setup", transfer_id = transfer_id, stage = stage, live_hub_full = live_full, held_hub_full = held_full, live_before = H.read_pod("cargo live before", live_pod, live_hub), held_before = H.read_pod("cargo held before", held_pod, held_hub), pod_errors = pod_errors }
end

function H.read_pod(label, pod, hub)
	local row = { label = label, tick = game.tick, game_paused = game.tick_paused == true, pod_valid = pod and pod.valid or false, hub_valid = hub and hub.valid or false }
	if pod and pod.valid then
		row.state = pod.cargo_pod_state
		if pod.surface and pod.surface.platform and pod.surface.platform.valid then row.platform_paused = pod.surface.platform.paused == true end
		local inv = pod.get_inventory(defines.inventory.cargo_unit)
		row.pod_items = inv and inv.get_contents() or nil
	end
	if hub and hub.valid then
		local inv = hub.get_inventory(defines.inventory.hub_main)
		row.hub_copper = inv and inv.get_item_count("copper-plate") or nil
		row.hub_iron = inv and inv.get_item_count("iron-plate") or nil
	end
	if hub and hub.valid then
		row.ground_copper = hub.surface.count_entities_filtered({ name = "item-on-ground" })
	end
	return row
end

function H.read_cargo_pods()
	local live_rec = storage.hold_completeness_lab.records.cargo_live
	local held_rec = storage.hold_completeness_lab.records.cargo_held
	local function find(label, rec_key)
		local p = H.find_platform(label)
		if not p then return nil, nil end
		local pod, hub = nil, nil
		for _, e in pairs(p.surface.find_entities_filtered({})) do
			if e.unit_number == rec_key.unit_number then pod = e end
			if e.unit_number == rec_key.hub_unit_number then hub = e end
		end
		return pod, hub
	end
	local live_pod, live_hub = find("cargo_live", live_rec)
	local held_pod, held_hub = find("cargo_held", held_rec)
	return { live_after = H.read_pod("cargo live after", live_pod, live_hub), held_after = H.read_pod("cargo held after", held_pod, held_hub) }
end

return { success = true, base = script.active_mods.base, tick = game.tick }
`;

function resetLab() {
	const first = lua(resetLua);
	rcon("/step-tick 2");
	const postTick = lua(resetLua);
	return {
		...first,
		post_tick: postTick,
		zero_storage: postTick.zero_storage,
		zero_surfaces: postTick.zero_surfaces,
		leftovers: postTick.leftovers,
		game_paused: postTick.game_paused,
	};
}

function changedValue(before, after, keyPath) {
	let a = before;
	let b = after;
	for (const key of keyPath) {
		a = a?.[key];
		b = b?.[key];
	}
	return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
}

function summarizeSpoilage(setup, after) {
	if (setup.status === "unconstructible") return setup;
	return {
		status: "passed",
		live_changed: changedValue(setup.live_before, after.live_after, ["stack", "spoil_percent"]) || changedValue(setup.live_before, after.live_after, ["stack", "name"]) || changedValue(setup.live_before, after.live_after, ["stack", "count"]),
		held_changed: changedValue(setup.held_before, after.held_after, ["stack", "spoil_percent"]) || changedValue(setup.held_before, after.held_after, ["stack", "name"]) || changedValue(setup.held_before, after.held_after, ["stack", "count"]),
		setup,
		after,
	};
}

function summarizeDamage(setup, after) {
	if (setup.status === "unconstructible") return setup;
	return {
		status: "passed",
		live_changed: changedValue(setup.live_before, after.live_after, ["target_health"]) || changedValue(setup.live_before, after.live_after, ["asteroid_position"]),
		held_changed: changedValue(setup.held_before, after.held_after, ["target_health"]) || changedValue(setup.held_before, after.held_after, ["asteroid_position"]),
		setup,
		after,
	};
}

function summarizeCargoPods(setup, after) {
	if (setup.status === "unconstructible") return setup;
	const liveChanged = changedValue(setup.live_before, after.live_after, ["state"]) || changedValue(setup.live_before, after.live_after, ["pod_valid"]) || changedValue(setup.live_before, after.live_after, ["hub_copper"]) || changedValue(setup.live_before, after.live_after, ["ground_copper"]);
	const heldChanged = changedValue(setup.held_before, after.held_after, ["state"]) || changedValue(setup.held_before, after.held_after, ["pod_valid"]) || changedValue(setup.held_before, after.held_after, ["hub_copper"]) || changedValue(setup.held_before, after.held_after, ["ground_copper"]);
	return { status: "passed", live_changed: liveChanged, held_changed: heldChanged, overflow_preserved: after.held_after?.pod_valid === true, setup, after };
}

const results = {
	script: "tests/hold-completeness-lab/run-pr0a.mjs",
	instance,
	controller,
	started: new Date().toISOString(),
	rungs: {},
	errors: [],
};

if (resetOnly) {
	const result = resetLab();
	console.log(JSON.stringify(result, null, 2));
	if (!result.zero_storage || !result.zero_surfaces || result.game_paused !== false) process.exitCode = 1;
	process.exit();
}

try {
	results.initial_reset = resetLab();
	results.install = lua(installLua);

	const spoilageSetup = lua("return __hold_completeness_lab.setup_spoilage()");
	stepTicks(600);
	const spoilageAfter = lua("return __hold_completeness_lab.read_spoilage()");
	results.rungs.spoilage = summarizeSpoilage(spoilageSetup, spoilageAfter);

	const damageSetup = lua("return __hold_completeness_lab.setup_damage()");
	stepTicks(600);
	const damageAfter = damageSetup.status === "unconstructible" ? {} : lua("return __hold_completeness_lab.read_damage()");
	results.rungs.damage = summarizeDamage(damageSetup, damageAfter);

	const cargoSetup = lua("return __hold_completeness_lab.setup_cargo_pods()");
	stepTicks(600);
	const cargoAfter = cargoSetup.status === "unconstructible" ? {} : lua("return __hold_completeness_lab.read_cargo_pods()");
	results.rungs.cargo_pods = summarizeCargoPods(cargoSetup, cargoAfter);
} catch (error) {
	results.errors.push(error.stack || error.message);
} finally {
	try { results.final_reset = resetLab(); } catch (error) { results.errors.push(`cleanup failed: ${error.stack || error.message}`); }
	results.evaluation = evaluateHoldCompletenessResults(results);
	results.finished = new Date().toISOString();
	appendFileSync(notebook, `\n\n## ${new Date().toISOString()} - PR-0A hold-completeness lab run (run-pr0a.mjs)\n\n\`\`\`json\n${JSON.stringify(results, null, 2)}\n\`\`\`\n`);
	console.log(JSON.stringify(results, null, 2));
	if (results.errors.length || !results.evaluation.ok) process.exitCode = 1;
}
