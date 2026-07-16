import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { assertIdlePreflight, cleanupAfterBuild, isPilotReady, parseArguments, sleep } from "./build-save.mjs";

const source = readFileSync(new URL("./build-save.mjs", import.meta.url), "utf8");

test("save builder requires pinned API input and create-only artifact output", () => {
	assert.deepEqual(parseArguments(["--runtime-api", "api.json", "--output", "gallery.zip", "--dry-run"]), {
		runtimeApi: "api.json", output: "gallery.zip", instance: "clusterio-host-1-instance-1", dryRun: true,
	});
	assert.throws(() => parseArguments(["--output", "gallery.zip"]), /--runtime-api/);
	assert.throws(() => parseArguments(["--runtime-api", "api.json"]), /--output/);
});

test("preflight refuses shared-cluster state before construction", () => {
	const idle = { gamePaused: false, surfaces: 0, labStorage: false, jobs: 0, locks: 0, holds: 0, tombstones: 0 };
	assert.deepEqual(assertIdlePreflight(idle), idle);
	for (const field of ["gamePaused", "surfaces", "labStorage", "jobs", "locks", "holds", "tombstones"]) {
		assert.throws(() => assertIdlePreflight({ ...idle, [field]: field === "gamePaused" || field === "labStorage" ? true : 1 }), new RegExp(field));
	}
});

test("pilot readiness requires exact per-line physical unstacked source and empty target", () => {
	const ready = { exists: true, sourceQuantity: 125, sourceLineQuantities: [67, 58], targetQuantity: 0, maximumStack: 1, physicalStacks: 125 };
	assert.equal(isPilotReady(ready), true);
	for (const patch of [
		{ sourceQuantity: 124 }, { sourceLineQuantities: [66, 59] }, { targetQuantity: 1 }, { maximumStack: 2 }, { physicalStacks: 124 },
	]) assert.equal(isPilotReady({ ...ready, ...patch }), false);
});

test("live builder guarantees cleanup and exclusive artifact publication", () => {
	assert.match(source, /finally/);
	assert.match(source, /operation:\s*["']cleanup["']/);
	assert.match(source, /COPYFILE_EXCL/);
	assert.match(source, /operation:\s*["']save["']/);
	assert.doesNotMatch(source, /operation:\s*["']feed["']/);
	assert.doesNotMatch(source, /game\.tick_paused\s*=/);
});

test("cleanup still performs final preflight after the cleanup call throws", () => {
	const calls = [];
	const boundary = cleanupAfterBuild(request => {
		calls.push(request.operation);
		if (request.operation === "cleanup") throw new Error("cleanup transport failed");
		return { success: true, gamePaused: false, surfaces: 1, labStorage: true, jobs: 0, locks: 0, holds: 0, tombstones: 0 };
	});
	assert.deepEqual(calls, ["cleanup", "preflight"]);
	assert.equal(boundary.errors.length, 2);
	assert.match(boundary.errors[0].message, /cleanup transport failed/);
	assert.match(boundary.errors[1].message, /surfaces/);
});

test("save stabilization delay resolves without external timing helpers", async () => {
	await sleep(0);
});
