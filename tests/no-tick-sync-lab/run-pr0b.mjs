#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { evaluateNoTickSyncResults } from "./evaluate.mjs";

const resetOnly = process.argv[2] === "--reset";
const argOffset = resetOnly ? 3 : 2;
const instance = process.argv[argOffset] || "clusterio-host-1-instance-1";
const controller = process.argv[argOffset + 1] || "surface-export-controller";
const notebook = process.argv[argOffset + 2] || "tests/no-tick-sync-lab/NOTEBOOK.md";

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
for _, surface in pairs(game.surfaces) do
	if string.find(surface.name, "no-tick-sync-lab-", 1, true) then
		local name = surface.name
		local ok, err = pcall(function() game.delete_surface(surface) end)
		deleted[#deleted + 1] = { name = name, ok = ok, error = ok and nil or tostring(err) }
	end
end
storage.no_tick_sync_lab = nil
__no_tick_sync_lab = nil
game.tick_paused = false
local leftovers = {}
for _, surface in pairs(game.surfaces) do
	if string.find(surface.name, "no-tick-sync-lab-", 1, true) then leftovers[#leftovers + 1] = surface.name end
end
return { success = true, deleted = deleted, zero_storage = storage.no_tick_sync_lab == nil, zero_surfaces = #leftovers == 0, leftovers = leftovers, game_paused = game.tick_paused }
`;

const runLua = `
local raw = remote.call("surface_export", "no_tick_sync_selftest_json")
return helpers.json_to_table(raw)
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

const results = {
	script: "tests/no-tick-sync-lab/run-pr0b.mjs",
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
	results.rungs.strict_gate_pass = lua(runLua);
} catch (error) {
	results.errors.push(error.stack || error.message);
} finally {
	try { results.final_reset = resetLab(); } catch (error) { results.errors.push(`cleanup failed: ${error.stack || error.message}`); }
	results.evaluation = evaluateNoTickSyncResults(results);
	results.finished = new Date().toISOString();
	appendFileSync(notebook, `\n\n## ${new Date().toISOString()} - PR-0B no-tick sync lab run (run-pr0b.mjs)\n\n\`\`\`json\n${JSON.stringify(results, null, 2)}\n\`\`\`\n`);
	console.log(JSON.stringify(results, null, 2));
	if (results.errors.length || !results.evaluation.ok) process.exitCode = 1;
}
