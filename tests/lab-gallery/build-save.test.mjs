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

const labSafeSurface = name => ({ name, generateWithLabTiles: true, hasGlobalElectricNetwork: true, ignoreSurfaceConditions: true });
const censusFor = settings => ({ surfaces: settings.map(row => ({ name: row.name, entityCount: 0, generatedChunks: 1 })) });

test("source and destination readiness are role-specific physical verdicts", () => {
	const sourceSettings = [labSafeSurface("lab-gallery-index-v2"), labSafeSurface("nauvis"), labSafeSurface("platform-2")];
	const sourceReading = {
		saveRole: "source", beltFixtureExact: true, reachabilityFixtureExact: true, corpusExact: true,
		transient: { gamePaused: false, jobs: 0, locks: 0, holds: 0, tombstones: 0 },
		surfaceSettings: sourceSettings, census: censusFor(sourceSettings),
	};
	assert.equal(assertSourceReady(sourceReading), sourceReading);
	assert.throws(() => assertSourceReady({ ...sourceReading, reachabilityFixtureExact: false }), /reachability/i);
	// Red tooth: a failed corpus fingerprint gate must fail source readiness.
	assert.throws(() => assertSourceReady({ ...sourceReading, corpusExact: false, corpusGate: { mismatches: ["omnibus-heat-temperature.temperature=490 expected 500"] } }), /corpus/i);

	const destinationSettings = [labSafeSurface("lab-gallery-index-v2"), labSafeSurface("nauvis")];
	const destinationReading = {
		saveRole: "destination", sourceBelts: 0, targetBelts: 0,
		reachability: { exists: false }, transient: sourceReading.transient, corpus: {},
		surfaceSettings: destinationSettings, census: censusFor(destinationSettings),
	};
	assert.equal(assertDestinationReady(destinationReading), destinationReading);
	assert.throws(() => assertDestinationReady({ ...destinationReading, sourceBelts: 1 }), /belt/i);
	// Red tooth: a lingering platform surface (a platform not yet destroyed) fails the destination.
	assert.throws(() => assertDestinationReady({ ...destinationReading, census: { surfaces: [{ name: "platform-2", entityCount: 3, generatedChunks: 1, platform: "lab-omnibus-state-v1" }] } }), /platform surfaces/);
	// Red tooth: a still-measured corpus fixture fails the destination.
	assert.throws(() => assertDestinationReady({ ...destinationReading, corpus: { "consumable-hub-1": { entities: 1 } } }), /corpus fixtures/);
});

test("the lab-safe surface gate is unsatisfiable by omission", () => {
	const settings = [labSafeSurface("nauvis")];
	const base = {
		saveRole: "source", beltFixtureExact: true, reachabilityFixtureExact: true, corpusExact: true,
		transient: { gamePaused: false, jobs: 0, locks: 0, holds: 0, tombstones: 0 },
		surfaceSettings: settings, census: censusFor(settings),
	};
	assert.equal(assertSourceReady(base), base);
	// A dropped or renamed runtime field must FAIL the gate, not skip it (the vacuous-gate class).
	assert.throws(() => assertSourceReady({ ...base, surfaceSettings: undefined }), /missing surfaceSettings/);
	assert.throws(() => assertSourceReady({ ...base, surfaceSettings: [] }), /missing surfaceSettings/);
	assert.throws(() => assertSourceReady({ ...base, census: undefined }), /missing census\.surfaces/);
	assert.throws(
		() => assertSourceReady({ ...base, census: { surfaces: [...censusFor(settings).surfaces, { name: "extra" }] } }),
		/census is incomplete/,
	);
	assert.throws(
		() => assertSourceReady({ ...base, surfaceSettings: [{ ...settings[0], ignoreSurfaceConditions: false }] }),
		/not lab-safe/,
	);
	assert.throws(
		() => assertSourceReady({ ...base, surfaceSettings: [{ name: "nauvis", generateWithLabTiles: 1, hasGlobalElectricNetwork: true, ignoreSurfaceConditions: true }] }),
		/not lab-safe/,
	);
});

test("platform surfaces are recorded as measured, never judged lab-safe", () => {
	// A platform's physics are the fixture under measurement (ignore_surface_conditions would
	// change can_place semantics for the reachability classification) — record, don't mutate.
	const settings = [
		labSafeSurface("lab-gallery-index-v2"), labSafeSurface("nauvis"),
		{ name: "platform-2", isPlatform: true, generateWithLabTiles: false, hasGlobalElectricNetwork: false, ignoreSurfaceConditions: false },
	];
	const reading = {
		saveRole: "source", beltFixtureExact: true, reachabilityFixtureExact: true, corpusExact: true,
		transient: { gamePaused: false, jobs: 0, locks: 0, holds: 0, tombstones: 0 },
		surfaceSettings: settings, census: censusFor(settings),
	};
	assert.equal(assertSourceReady(reading), reading);
	// The same non-true trio on a NON-platform surface still fails.
	const nonPlatform = settings.map(row => ({ ...row, isPlatform: undefined }));
	assert.throws(() => assertSourceReady({ ...reading, surfaceSettings: nonPlatform, census: censusFor(nonPlatform) }), /not lab-safe/);
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
