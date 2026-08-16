const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const pluginRoot = path.resolve(__dirname, "..");

function read(relPath) {
	return fs.readFileSync(path.join(pluginRoot, relPath), "utf8");
}

test("the export payload still carries the source platform's paused state", () => {
	const exportPipeline = read("module/core/export-pipeline.lua");
	assert.match(exportPipeline, /paused = platform\.paused == true,/);
});

test("a transfer import settles the destination at the CAPTURED paused state", () => {
	const importCompletion = read("module/core/import-completion.lua");
	assert.match(importCompletion, /local captured_paused = job\.platform_data\.platform\.paused == true/);
	assert.match(importCompletion, /pcall\(function\(\) tp\.paused = captured_paused end\)/);
	assert.match(importCompletion, /Platform %s settled at the CAPTURED paused=%s/);
});

test("the captured pause write is skipped when a park owns the terminal pause", () => {
	const importCompletion = read("module/core/import-completion.lua");
	assert.match(importCompletion,
		/if not job\.park_target and job\.target_platform and job\.target_platform\.valid then/);
});

test("the captured pause write is TERMINAL — after the gate, the unpause, and the park block", () => {
	const importCompletion = read("module/core/import-completion.lua");
	const gateRepause = importCompletion.indexOf("re-paused for validation");
	const unpause = importCompletion.indexOf("UNPAUSED after successful validation");
	const parkArrived = importCompletion.indexOf("arrived PAUSED at");
	const captured = importCompletion.indexOf("settled at the CAPTURED paused");
	assert.ok(gateRepause !== -1 && unpause !== -1 && parkArrived !== -1 && captured !== -1,
		"every pause site this ordering is pinned against must still exist");
	assert.ok(gateRepause < captured, "the frozen-world gate re-pause must precede the captured write");
	assert.ok(unpause < captured, "the success unpause must precede the captured write");
	assert.ok(parkArrived < captured, "the gateway park block must precede the captured write");
});

test("the captured pause outcome is recorded on the verdict, like the park's own outcome", () => {
	const importCompletion = read("module/core/import-completion.lua");
	assert.match(importCompletion, /result\.sourcePaused = captured_paused/);
	assert.match(importCompletion, /result\.sourcePausedApplied = ok_captured == true/);
	assert.match(importCompletion, /result\.gatewayParked = \(ok_pause and at_park\) or false/);
});
