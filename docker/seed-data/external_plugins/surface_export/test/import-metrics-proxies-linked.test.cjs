"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const distNode = path.join(__dirname, "..", "dist", "node");
const { buildImportMetrics } = require(path.join(distNode, "helpers.js"));

const moduleRoot = path.join(__dirname, "..", "module");
const completionSource = fs.readFileSync(path.join(moduleRoot, "core", "import-completion.lua"), "utf8");
const restorationSource = fs.readFileSync(
	path.join(moduleRoot, "import_phases", "entity_state_restoration.lua"), "utf8");

const STATE_COUNTERS = {
	circuits_connected: 12,
	copper_pruned: 5,
	proxies_linked: 3,
};

test("proxies_linked survives into the metrics the transaction log persists", () => {
	const metrics = buildImportMetrics({
		total_ticks: 44,
		...STATE_COUNTERS,
		not_an_allowlisted_metric: 99,
	});
	for (const [key, value] of Object.entries(STATE_COUNTERS)) {
		assert.equal(metrics[key], value,
			`${key} reaches the controller's raw event, but only enters summary.import — the store `
			+ "TransactionLogsTab renders and testkit log answers with — if buildImportMetrics carries it. "
			+ "The three counters leave EntityStateRestoration.restore_all together and their values here "
			+ "are distinct, so a counter wired to a sibling's source key cannot pass");
	}
	assert.equal(metrics.not_an_allowlisted_metric, undefined,
		"buildImportMetrics is an allowlist, not a passthrough: an unlisted key must not ride along");
});

test("an import that relinked no proxy targets stores zero, never an absent key", () => {
	const metrics = buildImportMetrics({});
	assert.equal(metrics.proxies_linked, 0,
		"proxies_linked defaults to 0 like every other count field — a payload carrying no proxy-container "
		+ "must not be readable as a counter that was never carried");
	assert.equal(buildImportMetrics(null), null,
		"no metrics and no duration is still no record at all");
});

test("the Lua half of the wire emits proxies_linked beside the sibling it was modelled on", () => {
	const marker = "copper_pruned = job.metrics.copper_pruned or 0,";
	const at = completionSource.indexOf(marker);
	assert.notEqual(at, -1,
		"the import-complete event's metrics table must still carry copper_pruned — this scan anchors on "
		+ "it, and an anchor that matches nothing would pass the check below vacuously");
	assert.equal(completionSource.lastIndexOf(marker), at,
		"the copper_pruned anchor must be unique: a second emission site would make this scan prove the "
		+ "wire for one of them and say nothing about the other");
	assert.match(completionSource, /proxies_linked = job\.metrics\.proxies_linked or 0,/,
		"buildImportMetrics can only carry a key the Lua event actually emits. Without this line the "
		+ "TypeScript allowlist reads 0 for every transfer, which is indistinguishable from a transfer "
		+ "that relinked nothing");
	assert.match(completionSource, /job\.metrics\.proxies_linked = state_result and state_result\.proxies_linked/,
		"the emission reads job.metrics, so the restore phase's return value must be assigned into it");
	assert.match(restorationSource, /proxies_linked = proxies_linked,/,
		"EntityStateRestoration.restore_all is where the count is produced — the assignment above reads "
		+ "state_result.proxies_linked, so a rename here silently zeroes the whole chain");
});
