import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
	classifyReachability,
	parseSections,
	validateSelectedEvidence,
	validateEvidence,
} from "./reachability-contract.mjs";
import {
	assertSafeToMutate,
	requireLuaSuccess,
	runCleanupBoth,
} from "./reachability-runner-helpers.mjs";

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

test("cleanup attempts and inspects every instance after an earlier failure", () => {
	const calls = [];
	const cleanup = runCleanupBoth(["one", "two"], {
		action(instance) {
			calls.push(`action:${instance}`);
			if (instance === "one") throw new Error("first failed");
			return { success: true };
		},
		inspect(instance) {
			calls.push(`inspect:${instance}`);
			return { success: true };
		},
	});

	assert.deepEqual(calls, ["action:one", "inspect:one", "action:two", "inspect:two"]);
	assert.match(cleanup.one.errors.join("\n"), /first failed/);
	assert.deepEqual(cleanup.two.errors, []);
});

test("preflight refuses to mutate while unrelated global state is active", () => {
	const clear = {
		one: { zero: { game_paused: false, destination_holds: 0, locked_platforms: 0, async_jobs: 0, committed_source_tombstones: 0 }, errors: [] },
	};
	assert.doesNotThrow(() => assertSafeToMutate(clear));

	for (const field of ["game_paused", "destination_holds", "locked_platforms", "async_jobs", "committed_source_tombstones"]) {
		const busy = structuredClone(clear);
		busy.one.zero[field] = field === "game_paused" ? true : 1;
		assert.throws(() => assertSafeToMutate(busy), new RegExp(field));
	}
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
	assert.match(runner, /storage\.committed_source_transfer_tombstones/);
	assert.doesNotMatch(runner, /storage\.committed_source_tombstones/);
	assert.doesNotMatch(runner, /game\.tick_paused\s*=\s*false/);
	assert.match(runner, /requireLuaSuccess\(result, instance\)/);
	assert.match(runner, /validateSelectedEvidence\(result, sections\)/);
	assert.doesNotMatch(runner, /transfer_platform|import_platform|export_platform/);
});
