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
			spoilage: { status: "passed", live_changed: true, held_changed: false },
			damage: { status: "passed", live_changed: true, held_changed: false },
			cargo_pods: { status: "passed", live_changed: true, held_changed: false, overflow_preserved: true },
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

test("requires live controls to move and held specimens to stay stable", () => {
	const summary = evaluateHoldCompletenessResults(baseResult({
		rungs: {
			spoilage: { status: "passed", live_changed: false, held_changed: false },
			damage: { status: "passed", live_changed: true, held_changed: true },
			cargo_pods: { status: "passed", live_changed: true, held_changed: false, overflow_preserved: false },
		},
	}));
	assert.equal(summary.ok, false);
	assert.match(summary.failures.join("\n"), /spoilage.*live control/);
	assert.match(summary.failures.join("\n"), /damage.*held specimen/);
	assert.match(summary.failures.join("\n"), /cargo_pods.*overflow/);
});
