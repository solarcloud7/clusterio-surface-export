import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { chunkEntities, executeR0, parseArguments, summarizeBoundary } from "./run-adjacency.mjs";

const runnerSource = readFileSync(new URL("./run-adjacency.mjs", import.meta.url), "utf8");
const runtimeSource = readFileSync(new URL("./lab-runtime.lua", import.meta.url), "utf8");
const savedR0 = JSON.parse(readFileSync(new URL("../results/adjacency-r0-2.0.77.json", import.meta.url), "utf8"));

test("runner accepts only the mandatory R0 rung", () => {
	assert.deepEqual(parseArguments(["--rung", "r0"]), { rung: "r0", injectFailure: false, dryRun: false });
	assert.throws(() => parseArguments(["--rung", "r1"]), /only r0/);
	assert.throws(() => parseArguments(["--unknown"]), /unknown argument/);
});

test("construction chunks never exceed 25 source rows", () => {
	const chunks = chunkEntities(Array.from({ length: 596 }, (_, entityId) => ({ entityId })));
	assert.equal(chunks.length, 24);
	assert.equal(chunks.at(-1).length, 21);
	assert.ok(chunks.every(chunk => chunk.length <= 25));
});

test("each mutation chunk is followed by read-free heartbeat and profiler evidence", () => {
	assert.match(runnerSource, /client\.call\("prepare_terrain"[\s\S]*client\.call\("heartbeat"/);
	assert.match(runnerSource, /client\.call\("construct"[\s\S]*client\.call\("heartbeat"/);
	assert.match(runtimeSource, /game\.create_profiler\(\)/);
	assert.match(runtimeSource, /result\.profiler = profiler/);
	assert.match(runnerSource, /rcon\.print\(profiler\)/);
	const heartbeatBody = runtimeSource.slice(runtimeSource.indexOf("local function heartbeat()"), runtimeSource.indexOf("local function prepare_terrain"));
	assert.doesNotMatch(heartbeatBody, /get_detailed_contents/);
});

test("R0 source has no insertion, scheduler, recovery, or spill path", () => {
	for (const forbidden of ["insert_at", "can_insert_at", "spill_item_stack", "reverse-first-fit"]) {
		assert.doesNotMatch(`${runnerSource}\n${runtimeSource}`, new RegExp(forbidden, "i"));
	}
	assert.doesNotMatch(runnerSource, /from\s+["'][^"']*scheduler/i);
});

test("runner preflights before construction and guarantees cleanup in finally", () => {
	assert.ok(runnerSource.indexOf("assertIdlePreflight") < runnerSource.indexOf("constructAll"));
	assert.ok(runnerSource.indexOf("prepareAll") < runnerSource.indexOf("constructAll"));
	assert.match(runnerSource, /finally\s*{/);
	assert.match(runnerSource, /await cleanupBoth/);
	assert.match(runnerSource, /await client\.endOwnedPause/);
	assert.match(runnerSource, /injectFailure/);
	assert.match(runnerSource, /schedulerRestoration = "NOT TESTED"/);
	assert.match(runnerSource, /injectedFailureBoundary/);
	assert.match(runnerSource, /evidence\.finalInspections/);
	assert.match(runnerSource, /result\.stopDetails = error\.details/);
});

test("runtime creates an unrestricted empty surface and clears construction collisions", () => {
	assert.doesNotMatch(runtimeSource, /width\s*=\s*1/);
	// 2.0.77 set_tiles positional order: tiles, correct, remove entities, remove decoratives, raise event.
	assert.match(runtimeSource, /surface\.set_tiles\(tiles, true, true, true, false\)/);
	const constructBody = runtimeSource.slice(runtimeSource.indexOf("local function construct()"), runtimeSource.indexOf("local function neighbour_ids"));
	assert.doesNotMatch(constructBody, /set_tiles/);
	assert.match(constructBody, /descriptor was not terrain-prepared/);
	assert.match(runtimeSource, /entity\.type == "transport-belt" and entity\.belt_shape or nil/);
	assert.match(runtimeSource, /entity\.type == "underground-belt" and entity\.belt_to_ground_type or nil/);
	assert.match(runtimeSource, /if entity\.type == "splitter" then/);
	assert.match(runtimeSource, /if entity\.type == "underground-belt" then partner = entity\.neighbours end/);
	assert.match(runtimeSource, /if entity\.type == "underground-belt" then expects_partner = descriptor\.expects_partner == true end/);
});

test("partial pause acquisition still releases the pause already owned", async () => {
	const calls = [];
	const first = {
		ownsPause: false,
		async call(operation) {
			calls.push(`first:${operation}`);
			if (operation === "inspect") return { success: true };
			if (operation === "cleanup") return { success: true };
			throw new Error(`unexpected ${operation}`);
		},
		async beginOwnedPause() { calls.push("first:begin"); this.ownsPause = true; },
		async endOwnedPause() { calls.push("first:end"); this.ownsPause = false; },
	};
	const second = {
		async call(operation) { calls.push(`second:${operation}`); return { success: true }; },
		async beginOwnedPause() { calls.push("second:begin"); throw new Error("pause race"); },
		async endOwnedPause() { calls.push("second:end"); },
	};
	const evidence = {};
	await assert.rejects(executeR0({ clients: [first, second], descriptors: [], surfaceName: "belt-adjacency-r0-test", evidence }), /pause race/);
	assert.ok(calls.includes("first:end"));
	assert.ok(calls.includes("second:end"));
	assert.equal(evidence.finalInspections.length, 2);
});

test("durable boundary evidence is compact but preserves profiler and zero-state proof", () => {
	const summary = summarizeBoundary({
		telemetry: { prepare: [{ rows: 25, operation: { profiler: "Duration: 2ms" }, heartbeat: { prepared: 25, profiler: "Duration: 0.1ms" } }], construct: [] },
		cleanupResults: [{ success: true, deleted: "belt-adjacency-r0-x", gamePaused: true, profiler: "Duration: 1ms" }],
		finalInspections: [{ success: true, gamePaused: false, surfaces: 0, surfaceItems: 0, groundItems: 0, labStorage: false, jobs: 0, locks: 0, holds: 0, tombstones: 0 }],
	});
	assert.deepEqual(summary.prepare, { chunks: 1, rows: 25, maximumProfilerMs: 2, lastHeartbeat: { prepared: 25, profiler: "Duration: 0.1ms" } });
	assert.equal(summary.cleanup.length, 1);
	assert.equal(summary.finalInspections[0].surfaces, 0);
});

test("saved R0 stop preserves the no-continuation proof boundary", () => {
	assert.equal(savedR0.status, "STOP");
	assert.equal(savedR0.belt_item_insertion, "NOT PERFORMED");
	assert.equal(savedR0.scheduler, "NOT TESTED");
	assert.equal(savedR0.restoration, "NOT TESTED");
	assert.equal(savedR0.production_changes, "NONE");
	assert.equal(savedR0.runtime.final_zero_state_both_instances.game_paused, false);
	assert.equal(savedR0.runtime.final_zero_state_both_instances.lab_surfaces, 0);
});
