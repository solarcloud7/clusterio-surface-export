"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const distNode = path.join(__dirname, "..", "dist", "node");
const { buildImportMetrics } = require(path.join(distNode, "helpers.js"));

const BELT_STATE = {
	belt_state_applied: 7,
	belt_state_unmatched: 3,
	belt_state_failed: 2,
	belt_state_merge_discarded: 1,
	belt_state_declined: 5,
};

test("the belt item-state counters survive into the metrics the transaction log persists", () => {
	const metrics = buildImportMetrics({
		total_ticks: 28,
		belt_items_restored: 19586,
		...BELT_STATE,
		not_an_allowlisted_metric: 99,
	});
	for (const [key, value] of Object.entries(BELT_STATE)) {
		assert.equal(metrics[key], value,
			`${key} reaches the controller's raw event, but only enters summary.import — the store `
			+ "TransactionLogsTab renders and testkit log answers with — if buildImportMetrics carries it. "
			+ "The five values are distinct so a counter wired to the wrong source key cannot pass");
	}
	assert.equal(metrics.not_an_allowlisted_metric, undefined,
		"buildImportMetrics is an allowlist, not a passthrough: an unlisted key must not ride along");
});

test("an import that reported no belt item state stores zeroes, never absent keys", () => {
	const metrics = buildImportMetrics({});
	for (const key of Object.keys(BELT_STATE)) {
		assert.equal(metrics[key], 0,
			`${key} defaults to 0 like every other count field — a payload carrying nothing must not be `
			+ "readable as a counter that was never carried");
	}
	assert.equal(buildImportMetrics(null), null,
		"no metrics and no duration is still no record at all");
});
