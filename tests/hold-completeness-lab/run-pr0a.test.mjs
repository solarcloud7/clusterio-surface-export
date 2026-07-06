import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync(new URL("./run-pr0a.mjs", import.meta.url), "utf8");

test("runner records the three blocking hold-completeness rungs", () => {
	assert.match(script, /rungs\.spoilage/);
	assert.match(script, /rungs\.damage/);
	assert.match(script, /rungs\.cargo_pods/);
	assert.match(script, /descending-pod overflow/i);
});

test("runner uses real destination hold stage and discard cleanup", () => {
	assert.match(script, /destination_hold_json", "stage"/);
	assert.match(script, /destination_hold_json", "discard"/);
	assert.doesNotMatch(script, /destination_hold_json", "go_live"/);
});

test("runner has lab reset and settled zero-leftover checks", () => {
	assert.match(script, /storage\.hold_completeness_lab = nil/);
	assert.match(script, /hold-completeness-lab-/);
	assert.match(script, /zero_storage/);
	assert.match(script, /zero_surfaces/);
	assert.match(script, /game\.tick_paused = false/);
	assert.match(script, /step-tick 2/);
	assert.match(script, /post_tick/);
});

test("runner appends raw JSON results to the notebook", () => {
	assert.match(script, /NOTEBOOK\.md/);
	assert.match(script, /appendFileSync/);
	assert.match(script, /JSON\.stringify\(results, null, 2\)/);
});
