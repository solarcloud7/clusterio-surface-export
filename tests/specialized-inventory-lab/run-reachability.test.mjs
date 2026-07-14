import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
	classifyReachability,
	parseSections,
	validateEvidence,
} from "./reachability-contract.mjs";

const runner = readFileSync(new URL("./run-reachability.mjs", import.meta.url), "utf8");

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
	assert.match(runner, /--reset/);
	assert.match(runner, /--no-notebook/);
	assert.match(runner, /surface\.get_property\("pressure"\)/);
	assert.match(runner, /surface\.get_property\("gravity"\)/);
	assert.match(runner, /prototypes\.entity/);
	assert.match(runner, /surface\.can_place_entity/);
	assert.match(runner, /#drill\.fluidbox/);
	assert.match(runner, /mining_target/);
	assert.match(runner, /clusterio-host-1-instance-1/);
	assert.match(runner, /clusterio-host-2-instance-1/);
	assert.match(runner, /storage\.destination_holds/);
	assert.match(runner, /storage\.locked_platforms/);
	assert.match(runner, /storage\.async_jobs/);
	assert.match(runner, /game\.tick_paused = false/);
	assert.doesNotMatch(runner, /transfer_platform|import_platform|export_platform/);
});
