import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
	classifyReachability,
	parseSections,
	validateSelectedEvidence,
	validateEvidence,
} from "./reachability-contract.mjs";
import { requireLuaSuccess } from "./reachability-runner-helpers.mjs";
import {
	LeaseBlockedError,
	parseRunnerArguments,
	resolveFixture,
	verifyFixtureFingerprint,
} from "./run-reachability.mjs";

const runner = readFileSync(new URL("./run-reachability.mjs", import.meta.url), "utf8");
const galleryManifest = JSON.parse(readFileSync(new URL("../lab-gallery/manifest.json", import.meta.url), "utf8"));

const measuredEvidence = {
	prototype: {
		pin: "2.0.77",
		tick: 322800,
		platform: { pressure: 0, gravity: 0 },
		entities: {
			"chemical-plant": { fluidbox_count: 4, can_place: true, surface_conditions: [] },
			"storage-tank": { fluidbox_count: 1, can_place: true, surface_conditions: [] },
			pump: { fluidbox_count: 1, can_place: true, surface_conditions: [] },
			"flamethrower-turret": {
				fluidbox_count: 1,
				can_place: false,
				surface_conditions: [{ property: "pressure", min: 10, max: 2000, actual: 0, passes: false }],
			},
			"fluid-wagon": {
				fluidbox_count: 1,
				can_place: false,
				surface_conditions: [{ property: "gravity", min: 1, max: 100, actual: 0, passes: false }],
			},
			"electric-mining-drill": { fluidbox_count: 1, can_place: true, surface_conditions: [] },
		},
	},
	placement: {
		pin: "2.0.77",
		tick: 179375,
		drill: {
			created: true,
			mining_target: null,
			live_fluidbox_count: 0,
			read_ok: false,
			write_ok: false,
		},
	},
};

test("section parser accepts the two rungs and rejects unknown work", () => {
	assert.deepEqual(parseSections("prototype,placement"), ["prototype", "placement"]);
	assert.deepEqual(parseSections("placement"), ["placement"]);
	assert.throws(() => parseSections("prototype,transfer"), /prototype,placement/);
	assert.throws(() => parseSections("placement,placement"), /duplicate/i);
});

test("tick zero is valid tick-stamped evidence", () => {
	const tickZero = structuredClone(measuredEvidence);
	tickZero.prototype.tick = 0;
	tickZero.placement.tick = 0;
	assert.deepEqual(validateEvidence(tickZero), []);
});

test("each selected rung validates without requiring unselected evidence", () => {
	assert.deepEqual(validateSelectedEvidence(measuredEvidence, ["prototype"]), []);
	assert.deepEqual(validateSelectedEvidence(measuredEvidence, ["placement"]), []);

	const missingPrototypeTick = structuredClone(measuredEvidence);
	delete missingPrototypeTick.prototype.tick;
	assert.match(validateSelectedEvidence(missingPrototypeTick, ["prototype"]).join("\n"), /tick-stamped/);
	assert.deepEqual(validateSelectedEvidence(missingPrototypeTick, ["placement"]), []);

	const missingDrillPrototypeCapability = structuredClone(measuredEvidence);
	missingDrillPrototypeCapability.prototype.entities["electric-mining-drill"].fluidbox_count = 0;
	assert.match(
		validateSelectedEvidence(missingDrillPrototypeCapability, ["prototype"]).join("\n"),
		/electric-mining-drill reachability changed/,
	);
});

test("Lua failures are rejected instead of becoming evidence", () => {
	assert.deepEqual(requireLuaSuccess({ success: true, tick: 7 }, "source"), { success: true, tick: 7 });
	assert.throws(
		() => requireLuaSuccess({ success: false, error: "probe exploded" }, "source"),
		/source.*probe exploded/,
	);
});

test("runner arguments include lease recovery and reject unknown flags", () => {
	assert.equal(parseRunnerArguments([]).releaseLease, false);
	assert.equal(parseRunnerArguments(["--release-lease"]).releaseLease, true);
	assert.deepEqual(parseRunnerArguments(["--sections", "placement"]).sections, ["placement"]);
	assert.throws(() => parseRunnerArguments(["--reset"]), /Unknown argument/);
});

test("a stale lease classifies as BLOCKED, distinct from a measurement failure", () => {
	const blocked = new LeaseBlockedError("stale lease");
	assert.equal(blocked instanceof LeaseBlockedError, true);
	assert.equal(new Error("measurement failed") instanceof LeaseBlockedError, false);
	assert.match(runner, /status = error instanceof LeaseBlockedError \? "BLOCKED" : "FAILED"/);
	assert.match(runner, /--release-lease/);
});

test("the manifest fixture is resolved and its fingerprint machine-checked against evidence", () => {
	const fixture = resolveFixture(galleryManifest);
	assert.equal(fixture.id, "specialized-fluid-reachability");
	assert.ok(Number.isInteger(fixture.revision));
	assert.throws(() => resolveFixture({ fixtures: [] }), /no fixture/);

	const matching = structuredClone(measuredEvidence);
	matching.placement.drill.name = fixture.fingerprint.drillName;
	assert.deepEqual(verifyFixtureFingerprint(fixture, matching, ["prototype", "placement"]), []);

	const drifted = structuredClone(matching);
	drifted.placement.drill.live_fluidbox_count = 1;
	assert.match(verifyFixtureFingerprint(fixture, drifted, ["placement"]).join("\n"), /liveFluidboxCount/);
	// A section that was not run must not be fingerprint-judged.
	assert.deepEqual(verifyFixtureFingerprint(fixture, drifted, ["prototype"]), []);
});

test("current-pin evidence reproduces the final specialized-fluid classification", () => {
	assert.deepEqual(classifyReachability(measuredEvidence), {
		"chemical-plant": true,
		"storage-tank": true,
		pump: true,
		"flamethrower-turret": false,
		"fluid-wagon": false,
		"electric-mining-drill": false,
	});
	assert.deepEqual(validateEvidence(measuredEvidence), []);
});

test("the drill conclusion depends on live entity state, not prototype capability alone", () => {
	const changed = structuredClone(measuredEvidence);
	changed.placement.drill.live_fluidbox_count = 1;
	changed.placement.drill.read_ok = true;
	assert.equal(classifyReachability(changed)["electric-mining-drill"], true);
	assert.match(validateEvidence(changed).join("\n"), /electric-mining-drill/);
});

test("runner measures the engine and cleans both instances without touching transfers", () => {
	assert.match(runner, /--sections/);
	assert.match(runner, /--save/);
	assert.match(runner, /--no-notebook/);
	assert.match(runner, /lab-gallery-source-surface-export-2\.0\.77\.zip/);
	assert.match(runner, /baked-reachability-meter\.cjs/);
	assert.match(runner, /--start-server/);
	assert.match(runner, /surface-export-host-2/);
	assert.match(runner, /finally/);
	assert.doesNotMatch(runner, /clusterioctl|send-rcon|clusterio-host-1-instance-1/);
	assert.doesNotMatch(runner, /create_space_platform|create_entity|delete_surface|destroy\(\)|set_tiles/);
	assert.doesNotMatch(runner, /game\.tick_paused\s*=\s*false/);
	assert.match(runner, /validateSelectedEvidence\(result, options\.sections\)/);
	assert.match(runner, /verifyFixtureFingerprint\(fixture, evidence, options\.sections\)/);
	assert.doesNotMatch(runner, /transfer_platform|import_platform|export_platform/);
});
