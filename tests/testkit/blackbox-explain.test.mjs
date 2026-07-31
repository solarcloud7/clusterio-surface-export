// blackboxExplain's own tests, against the REAL minted fixture — a bundle banked by an actual gate
// failure (clone of lab-omnibus-state-v1, stripped to hub + 3 chests, transferred with the one-shot
// `test_force_item_loss = 1` hook armed on the destination; iron-plate 200 → 199). The fixture is
// the production writer's real output, so a schema change in `bank_failure_black_box` that the
// explain tool cannot decode fails HERE, before it fails during a live incident.
//
// Cluster-free by construction: the fixture is committed; the FAQ table is read from docs/.
import assert from "node:assert/strict";
import test from "node:test";

import {
	explainBlackBoxFile, formatExplanation, loadTriageTable,
} from "../../tools/tests/testkit/blackbox-explain.mjs";

const FIXTURE = new URL("../../tools/tests/testkit/fixtures/failure-black-box-sample.json", import.meta.url)
	.pathname.replace(/^\/([A-Za-z]:)/, "$1");

const report = explainBlackBoxFile(FIXTURE);

test("explain decodes the minted bundle: stage, diff row, tick span", () => {
	assert.equal(report.failureStage, "items");
	assert.equal(report.selfReport.diffRows.length, 1);
	const row = report.selfReport.diffRows[0];
	assert.equal(row.name, "iron-plate");
	assert.equal(row.expected, 200);
	assert.equal(row.actual, 199);
	assert.equal(row.delta, -1);
	assert.equal(report.bundle.platform, "integration-test-blackbox-mint");
	assert.ok(report.bundle.importTickSpan >= 0);
});

test("explain keeps the measurement boundary: self-report and physical scan are separate, labeled facts", () => {
	// The gate's accounting lives under selfReport; the independent dest scan under physicalScan.
	assert.ok(report.selfReport.expectedItemTypes > 0);
	assert.equal(report.physicalScan.destEntityCount, 4, "hub + 3 seeded chests");
	assert.equal(report.physicalScan.destFluidSegmentCount, 0,
		"an empty Lua table serializes as {} — zero must decode as 0, never null");
	const human = formatExplanation(report);
	assert.match(human, /self-report/);
	assert.match(human, /physical scan/);
	assert.match(human, /NOT in the bundle/, "must say phase timings live elsewhere, not fabricate them");
});

test("triage hint reads the FAQ table and carries the not-root-cause caveat", () => {
	// The forced-loss signature (items, one name, single-digit LOST) deliberately matches the belt
	// class row — which is exactly why the hint must carry the caveat.
	assert.equal(report.triage.matched, true);
	assert.match(report.triage.caveat, /HINT/);
	assert.match(report.triage.action, /once/i);
});

test("triage table parses from docs/ENGINEERING_FAQ.md (one truth — no classes restated in code)", () => {
	const table = loadTriageTable();
	assert.equal(table.unavailable, undefined);
	assert.ok(table.rows.length >= 3, `expected the three known rows, got ${table.rows.length}`);
	for (const row of table.rows) {
		assert.ok(row.signature && row.knownClass && row.action);
	}
});

test("replay payload is present and reimportable-shaped", () => {
	assert.equal(report.replay.present, true);
	assert.equal(report.replay.entityCount, 4);
	assert.ok(report.replay.tileCount > 0);
});
