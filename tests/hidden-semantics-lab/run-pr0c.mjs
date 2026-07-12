#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const resetOnly = process.argv[2] === "--reset";
const argOffset = resetOnly ? 3 : 2;
const instance = process.argv[argOffset] || "clusterio-host-1-instance-1";
const controller = process.argv[argOffset + 1] || "surface-export-controller";
const notebook = process.argv[argOffset + 2] || "tests/hidden-semantics-lab/NOTEBOOK.md";

const PREFIX = "hidden-semantics-lab-";

const manualObservationChecklist = [
	{
		id: "space-platform-list",
		prompt: "Open the in-game Space platforms list and search for both lab platform names.",
		expected: "visible-control appears; held-destination is absent.",
	},
	{
		id: "remote-view-picker-map-search",
		prompt: "Use remote view and map-style platform navigation/search for both lab platform names.",
		expected: "visible-control can be selected normally; held-destination is absent or inert.",
	},
	{
		id: "direct-references",
		prompt: "Watch alerts, dialogs, selectors, side panels, and player-facing platform references for the held platform name.",
		expected: "held-destination does not appear in ordinary player-facing UI.",
	},
	{
		id: "attempted-interaction",
		prompt: "If the held platform is exposed anywhere, try the least destructive interaction and record whether it opens, enters, or changes the platform.",
		expected: "no interaction opens the held surface, moves a player, makes it live, or moves items/entities off-platform.",
	},
	{
		id: "control-sanity",
		prompt: "Repeat the same path against the visible-control platform.",
		expected: "visible-control remains discoverable, proving the UI path was exercised.",
	},
	{
		id: "cleanup-sanity",
		prompt: "Run the reset command and confirm neither lab platform remains visible.",
		expected: "zero lab platforms, zero lab holds, game unpaused.",
	},
];

const expectedSafeResults = {
	visible_control: "appears normally and proves the player-facing UI path was exercised",
	held_destination: "hidden from ordinary player-facing platform lists, remote view pickers, map search, alerts, dialogs, and selectors",
	exposed_text: "confusing but inert text is UX backlog if it cannot open, enter, observe, or mutate the held surface",
	unsafe_blocker: "any path that lets a connected player view, enter, interact with, or observe live state on the held destination blocks Phase-2 wiring",
	cleanup: "reset leaves zero lab destination holds, zero lab platforms, and game.tick_paused == false",
};

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

const resetLua = `
local deleted = {}
if storage.destination_holds then
	for transfer_id, _ in pairs(storage.destination_holds) do
		if type(transfer_id) == "string" and string.find(transfer_id, "${PREFIX}", 1, true) then
			local ok, result = pcall(function() return remote.call("surface_export", "destination_hold", "discard", transfer_id) end)
			deleted[#deleted + 1] = { transfer_id = transfer_id, discard_ok = ok, discard_result = ok and result or tostring(result) }
			storage.destination_holds[transfer_id] = nil
		end
	end
end
for _, surface in pairs(game.surfaces) do
	local p = surface.platform
	if p and p.valid and string.find(p.name, "${PREFIX}", 1, true) then
		local row = { name = p.name }
		local ok, err = pcall(function() game.delete_surface(surface) end)
		row.ok = ok
		if not ok then row.error = tostring(err) end
		deleted[#deleted + 1] = row
	end
end
storage.hidden_semantics_lab = nil
game.tick_paused = false
local leftovers = {}
for _, surface in pairs(game.surfaces) do
	local p = surface.platform
	if p and p.valid and string.find(p.name, "${PREFIX}", 1, true) then leftovers[#leftovers + 1] = p.name end
end
local hold_leftovers = {}
if storage.destination_holds then
	for transfer_id, _ in pairs(storage.destination_holds) do
		if type(transfer_id) == "string" and string.find(transfer_id, "${PREFIX}", 1, true) then hold_leftovers[#hold_leftovers + 1] = transfer_id end
	end
end
return {
	success = true,
	deleted = deleted,
	zero_storage = storage.hidden_semantics_lab == nil and #hold_leftovers == 0,
	zero_surfaces = #leftovers == 0,
	leftovers = leftovers,
	hold_leftovers = hold_leftovers,
	game_paused = game.tick_paused,
}
`;

const setupLua = `
local force = game.forces.player
if not (force and force.valid) then error("player force missing") end

local function make_platform(label)
	local platform = force.create_space_platform({
		name = "${PREFIX}" .. label .. "-" .. tostring(game.tick),
		planet = "nauvis",
		starter_pack = "space-platform-starter-pack",
	})
	platform.apply_starter_pack()
	platform.paused = false
	force.set_surface_hidden(platform.surface, false)
	return platform
end

local visible = make_platform("visible-control")
local held = make_platform("held-destination")
local transfer_id = "${PREFIX}" .. "transfer-" .. tostring(game.tick)
local raw = remote.call("surface_export", "destination_hold_json", "stage", transfer_id, held.index, "player")
local stage = helpers.json_to_table(raw)
if not stage.success then error("destination_hold stage failed: " .. tostring(stage.error)) end
storage.hidden_semantics_lab = {
	transfer_id = transfer_id,
	visible = { name = visible.name, index = visible.index, surface_index = visible.surface.index },
	held = { name = held.name, index = held.index, surface_index = held.surface.index },
	setup_tick = game.tick,
}
return {
	success = true,
	instance_note = "connect a human client to the target instance before recording observations",
	tick = game.tick,
	game_paused = game.tick_paused,
	transfer_id = transfer_id,
	visible = {
		name = visible.name,
		index = visible.index,
		surface_index = visible.surface.index,
		hidden = force.get_surface_hidden(visible.surface),
		paused = visible.paused,
	},
	held = {
		name = held.name,
		index = held.index,
		surface_index = held.surface.index,
		hidden = force.get_surface_hidden(held.surface),
		paused = held.paused,
		hold = stage.hold,
	},
}
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
		hold_leftovers: postTick.hold_leftovers,
		game_paused: postTick.game_paused,
	};
}

if (resetOnly) {
	const result = resetLab();
	console.log(JSON.stringify(result, null, 2));
	if (!result.zero_storage || !result.zero_surfaces || result.game_paused !== false) process.exitCode = 1;
	process.exit();
}

const results = {
	script: "tests/hidden-semantics-lab/run-pr0c.mjs",
	instance,
	controller,
	started: new Date().toISOString(),
	manual: true,
	rungs: {},
	errors: [],
	manual_observation_checklist: manualObservationChecklist,
	expected_safe_results: expectedSafeResults,
};

try {
	results.initial_reset = resetLab();
	results.rungs.setup = lua(setupLua);
} catch (error) {
	results.errors.push(error.stack || error.message);
} finally {
	results.finished = new Date().toISOString();
	appendFileSync(notebook, `\n\n## ${new Date().toISOString()} - PR-0C hidden-semantics setup (run-pr0c.mjs)\n\n\`\`\`json\n${JSON.stringify(results, null, 2)}\n\`\`\`\n\nHuman observation notes: TODO\n`);
	console.log(JSON.stringify(results, null, 2));
	if (results.errors.length || !results.rungs.setup?.success) process.exitCode = 1;
}
