import assert from "node:assert/strict";
import test from "node:test";

import { evaluateNoTickSyncResults } from "./evaluate.mjs";

const cleanFinalReset = {
	zero_storage: true,
	zero_surfaces: true,
	leftovers: [],
	game_paused: false,
};

function baseResult(overrides = {}) {
	return {
		rungs: {
			strict_gate_pass: {
				status: "passed",
				tick_before: 123,
				tick_after: 123,
				crafting_progress_before: 0.42,
				crafting_progress_after: 0.42,
				held_item_after_restore: { name: "iron-plate", count: 1, quality: "normal" },
				held_item_after_validation: { name: "iron-plate", count: 1, quality: "normal" },
				held_item_intentional_restore: true,
				validation_called: true,
				validation_success: true,
			},
		},
		final_reset: cleanFinalReset,
		...overrides,
	};
}

test("accepts a same-tick strict-gate pass with unchanged machine and hand state", () => {
	const summary = evaluateNoTickSyncResults(baseResult());
	assert.equal(summary.ok, true);
	assert.deepEqual(summary.failures, []);
	assert.equal(summary.checks.strict_gate_pass.ok, true);
	assert.equal(summary.checks.cleanup.ok, true);
});

test("rejects tick advance and crafting-progress movement", () => {
	const summary = evaluateNoTickSyncResults(baseResult({
		rungs: {
			strict_gate_pass: {
				status: "passed",
				tick_before: 123,
				tick_after: 124,
				crafting_progress_before: 0.42,
				crafting_progress_after: 0.43,
				held_item_after_restore: { name: "iron-plate", count: 1, quality: "normal" },
				held_item_after_validation: { name: "iron-plate", count: 1, quality: "normal" },
				held_item_intentional_restore: true,
				validation_called: true,
				validation_success: true,
			},
		},
	}));
	assert.equal(summary.ok, false);
	assert.match(summary.failures.join("\n"), /tick advanced/);
	assert.match(summary.failures.join("\n"), /crafting_progress changed/);
});

test("rejects held-item swing after the restore write", () => {
	const summary = evaluateNoTickSyncResults(baseResult({
		rungs: {
			strict_gate_pass: {
				status: "passed",
				tick_before: 123,
				tick_after: 123,
				crafting_progress_before: 0.42,
				crafting_progress_after: 0.42,
				held_item_after_restore: { name: "iron-plate", count: 1, quality: "normal" },
				held_item_after_validation: null,
				held_item_intentional_restore: true,
				validation_called: true,
				validation_success: false,
			},
		},
	}));
	assert.equal(summary.ok, false);
	assert.match(summary.failures.join("\n"), /held item changed/);
	assert.match(summary.failures.join("\n"), /validation did not succeed/);
});

test("requires cleanup to prove zero lab state", () => {
	const summary = evaluateNoTickSyncResults(baseResult({
		final_reset: { zero_storage: false, zero_surfaces: true, leftovers: ["no-tick-sync-lab-1"], game_paused: false },
	}));
	assert.equal(summary.ok, false);
	assert.match(summary.failures.join("\n"), /cleanup/);
});
