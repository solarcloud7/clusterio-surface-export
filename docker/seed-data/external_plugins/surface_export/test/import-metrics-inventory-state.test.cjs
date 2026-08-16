"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const distNode = path.join(__dirname, "..", "dist", "node");
const { buildImportMetrics } = require(path.join(distNode, "helpers.js"));

const INVENTORY_STATE = {
	inventory_state_applied: 11,
	inventory_state_declined: 4,
	inventory_state_failed: 6,
};

test("the inventory item-state counters survive into the metrics the transaction log persists", () => {
	const metrics = buildImportMetrics({
		total_ticks: 31,
		belt_state_declined: 5,
		...INVENTORY_STATE,
		not_an_allowlisted_metric: 99,
	});
	for (const [key, value] of Object.entries(INVENTORY_STATE)) {
		assert.equal(metrics[key], value,
			`${key} reaches the controller's raw event, but only enters summary.import — the store `
			+ "TransactionLogsTab renders and testkit log answers with — if buildImportMetrics carries it. "
			+ "The three values are distinct, and distinct from the belt counter beside them, so a counter "
			+ "wired to the wrong source key cannot pass");
	}
	assert.equal(metrics.belt_state_declined, 5,
		"the belt path's declined counter keeps its own value: the two paths count separately");
	assert.equal(metrics.not_an_allowlisted_metric, undefined,
		"buildImportMetrics is an allowlist, not a passthrough: an unlisted key must not ride along");
});

test("an import that restored no export_string stacks stores zeroes, never absent keys", () => {
	const metrics = buildImportMetrics({});
	for (const key of Object.keys(INVENTORY_STATE)) {
		assert.equal(metrics[key], 0,
			`${key} defaults to 0 like every other count field — a payload carrying nothing must not be `
			+ "readable as a counter that was never carried");
	}
});
