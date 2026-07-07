import assert from "node:assert/strict";
import test from "node:test";

import { evaluateHoldCompletenessResults } from "./evaluate.mjs";

const cleanFinalReset = {
	zero_storage: true,
	zero_surfaces: true,
	leftovers: [],
	game_paused: false,
};

function baseResult(overrides = {}) {
	return {
		rungs: {
			spoilage: { status: "passed", live_changed: true, held_changed: true, live_drift: 0.10, held_drift: 0.10, nothing_left_platform: true },
			damage: { status: "passed", live_changed: true, held_changed: true, live_drift: 1, held_drift: 1, platform_damage: 0, nothing_left_platform: true },
			cargo_pods: { status: "passed", live_changed: true, held_changed: false, live_drift: 1, held_drift: 0, staged_pod_free: true, nothing_left_platform: true, overflow_preserved: true },
		},
		final_reset: cleanFinalReset,
		...overrides,
	};
}

test("accepts measured hold-completeness pass with zero leftovers", () => {
	const summary = evaluateHoldCompletenessResults(baseResult());
	assert.equal(summary.ok, true);
	assert.deepEqual(summary.failures, []);
	assert.equal(summary.checks.spoilage.ok, true);
	assert.equal(summary.checks.damage.ok, true);
	assert.equal(summary.checks.cargo_pods.ok, true);
	assert.equal(summary.checks.cleanup.ok, true);
});

test("does not let unconstructible rungs satisfy the blocking gate", () => {
	const summary = evaluateHoldCompletenessResults(baseResult({
		rungs: {
			spoilage: { status: "unconstructible", reason: "no spoilable candidate" },
			damage: { status: "passed", live_changed: true, held_changed: false },
			cargo_pods: { status: "passed", live_changed: true, held_changed: false, overflow_preserved: true },
		},
	}));
	assert.equal(summary.ok, false);
	assert.match(summary.failures.join("\n"), /spoilage.*unconstructible/);
});

test("requires cleanup to prove zero lab state", () => {
	const summary = evaluateHoldCompletenessResults(baseResult({
		final_reset: { zero_storage: false, zero_surfaces: true, leftovers: ["hold-completeness-lab-live-1"], game_paused: false },
	}));
	assert.equal(summary.ok, false);
	assert.match(summary.failures.join("\n"), /cleanup/);
});

test("requires live controls, no-worse held drift, zero platform damage, and no platform escape", () => {
	const summary = evaluateHoldCompletenessResults(baseResult({
		rungs: {
			spoilage: { status: "passed", live_changed: false, held_changed: false, live_drift: 0, held_drift: 0, nothing_left_platform: true },
			damage: { status: "passed", live_changed: true, held_changed: true, live_drift: 1, held_drift: 2, platform_damage: 1, nothing_left_platform: false },
			cargo_pods: { status: "passed", live_changed: true, held_changed: false, live_drift: 1, held_drift: 0, staged_pod_free: false, nothing_left_platform: false, overflow_preserved: true },
		},
	}));
	assert.equal(summary.ok, false);
	assert.match(summary.failures.join("\n"), /spoilage.*live control/);
	assert.match(summary.failures.join("\n"), /damage.*held drift/);
	assert.match(summary.failures.join("\n"), /damage.*platform damage/);
	assert.match(summary.failures.join("\n"), /damage.*left the platform/);
	assert.match(summary.failures.join("\n"), /cargo_pods.*pod-free/);
	assert.match(summary.failures.join("\n"), /cargo_pods.*left the platform/);
});


test("accepts held drift equal to live control drift", () => {
	const summary = evaluateHoldCompletenessResults(baseResult({
		rungs: {
			spoilage: { status: "passed", live_changed: true, held_changed: true, live_drift: 0.0007962962963, held_drift: 0.0007962962963, nothing_left_platform: true },
			damage: { status: "passed", live_changed: true, held_changed: true, live_drift: 1, held_drift: 1, platform_damage: 0, nothing_left_platform: true },
			cargo_pods: { status: "passed", live_changed: true, held_changed: false, live_drift: 1, held_drift: 0, staged_pod_free: true, nothing_left_platform: true, overflow_preserved: true },
		},
	}));
	assert.equal(summary.ok, true);
});
