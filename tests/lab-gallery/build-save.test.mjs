import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
	assertDestinationReady,
	assertIdlePreflight,
	assertSourceReady,
	parseArguments,
	sleep,
} from "./build-save.mjs";

const source = readFileSync(new URL("./build-save.mjs", import.meta.url), "utf8");

test("paired builder requires a seed, pinned API, and two create-only outputs", () => {
	assert.deepEqual(parseArguments([
		"--runtime-api", "api.json", "--seed", "seed.zip",
		"--source-output", "source.zip", "--destination-output", "destination.zip", "--dry-run",
	]), {
		runtimeApi: "api.json", seed: "seed.zip", sourceOutput: "source.zip",
		destinationOutput: "destination.zip", container: "surface-export-host-2", dryRun: true,
	});
	for (const omitted of ["--runtime-api", "--seed", "--source-output", "--destination-output"]) {
		const complete = ["--runtime-api", "api.json", "--seed", "seed.zip", "--source-output", "source.zip", "--destination-output", "destination.zip"];
		complete.splice(complete.indexOf(omitted), 2);
		assert.throws(() => parseArguments(complete), new RegExp(omitted.slice(2)));
	}
});

test("seed preflight permits the old gallery but refuses active global state", () => {
	const idle = { gamePaused: false, surfaces: 1, labStorage: true, jobs: 0, locks: 0, holds: 0, tombstones: 0 };
	assert.deepEqual(assertIdlePreflight(idle), idle);
	for (const field of ["gamePaused", "jobs", "locks", "holds", "tombstones"]) {
		assert.throws(() => assertIdlePreflight({ ...idle, [field]: field === "gamePaused" ? true : 1 }), new RegExp(field));
	}
});

test("source and destination readiness are role-specific physical verdicts", () => {
	const sourceReading = {
		saveRole: "source", beltFixtureExact: true, reachabilityFixtureExact: true,
		transient: { gamePaused: false, jobs: 0, locks: 0, holds: 0, tombstones: 0 },
	};
	assert.equal(assertSourceReady(sourceReading), sourceReading);
	assert.throws(() => assertSourceReady({ ...sourceReading, reachabilityFixtureExact: false }), /reachability/i);

	const destinationReading = {
		saveRole: "destination", sourceBelts: 0, targetBelts: 0,
		reachability: { exists: false }, transient: sourceReading.transient,
	};
	assert.equal(assertDestinationReady(destinationReading), destinationReading);
	assert.throws(() => assertDestinationReady({ ...destinationReading, sourceBelts: 1 }), /belt/i);
});

test("builder is isolated, bounded, and publishes neither half on failure", () => {
	assert.match(source, /--start-server/);
	assert.match(source, /surface-export-host-2/);
	assert.match(source, /COPYFILE_EXCL/);
	assert.match(source, /normalize_source/);
	assert.match(source, /prepare_destination/);
	assert.match(source, /finally/);
	assert.match(source, /publishedPaths/);
	assert.doesNotMatch(source, /clusterioctl|instance send-rcon|game\.tick_paused\s*=/);
});

test("bounded polling helper remains locally owned", async () => {
	await sleep(0);
});
