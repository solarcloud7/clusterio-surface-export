import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync(new URL("./run-pr0b.mjs", import.meta.url), "utf8");
const selftest = readFileSync(new URL("../../docker/seed-data/external_plugins/surface_export/module/interfaces/remote/no-tick-sync-selftest.lua", import.meta.url), "utf8");

test("runner exercises the real strict-gate helper path", () => {
	assert.match(script, /no_tick_sync_selftest_json/);
	assert.match(selftest, /restore_held_items_only/);
	assert.match(selftest, /TransferValidation\.validate_import/);
	assert.match(selftest, /strict = true/);
	assert.doesNotMatch(selftest, /skip_fluid_validation/);
});

test("runner records tick, crafting-progress, and held-item meters", () => {
	assert.match(selftest, /tick_before/);
	assert.match(selftest, /tick_after/);
	assert.match(selftest, /crafting_progress_before/);
	assert.match(selftest, /crafting_progress_after/);
	assert.match(selftest, /held_item_after_restore/);
	assert.match(selftest, /held_item_after_validation/);
	assert.match(selftest, /held_item_intentional_restore/);
});

test("runner has lab reset and zero-leftover checks", () => {
	assert.match(script, /storage\.no_tick_sync_lab = nil/);
	assert.match(script, /no-tick-sync-lab-/);
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
