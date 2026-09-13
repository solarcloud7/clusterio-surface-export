import assert from "node:assert/strict";
import test from "node:test";
import { copyFileSync, mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
	explainBlackBox, explainBlackBoxFile, formatExplanation,
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
	assert.ok(report.selfReport.expectedItemTypes > 0);
	assert.equal(report.physicalScan.destEntityCount, 4, "hub + 3 seeded chests");
	assert.equal(report.physicalScan.destFluidSegmentCount, 0,
		"an empty Lua table serializes as {} — zero must decode as 0, never null");
	const human = formatExplanation(report);
	assert.match(human, /self-report/);
	assert.match(human, /physical scan/);
	assert.match(human, /NOT in the bundle/, "must say phase timings live elsewhere, not fabricate them");
});

test("the explainer works outside the repository with only the recorded bundle", async () => {
	const directory = mkdtempSync(join(tmpdir(), "surface-export-blackbox-"));
	const modulePath = join(directory, "blackbox-explain.mjs");
	try {
		copyFileSync(new URL("../../tools/tests/testkit/blackbox-explain.mjs", import.meta.url), modulePath);
		const standalone = await import(pathToFileURL(modulePath).href);
		assert.deepEqual(standalone.explainBlackBoxFile(FIXTURE), report);
		assert.equal(standalone.formatExplanation(report), formatExplanation(report));
	} finally {
		rmSync(modulePath, { force: true });
		rmdirSync(directory);
	}
});

test("explanation reports evidence without inferred causes or retry advice", () => {
	assert.equal(Object.hasOwn(report, "triage"), false);
	assert.doesNotMatch(formatExplanation(report), /triage|known class|retry/i);
});

test("replay payload is present and reimportable-shaped", () => {
	assert.equal(report.replay.present, true);
	assert.equal(report.replay.entityCount, 4);
	assert.ok(report.replay.tileCount > 0);
});

const bundleWith = (diff) => explainBlackBox({
	transfer_id: "t", platform_name: "p", gate_tick: 2, started_tick: 1, mods: {},
	expected: { items: {}, fluids: {} }, actual: { items: {}, fluids: {} },
	diff, physical_entities: [], physical_fluid_segments: {},
});

test("fluid gains retain their measured direction and amount", () => {
	const gained = bundleWith({ items: {}, fluids: { water: { expected: 100, actual: 9000, delta: 8900 } } });
	assert.equal(gained.failureStage, "fluids");
	assert.equal(gained.selfReport.diffRows[0].delta, 8900);
	assert.match(formatExplanation(gained), /GAINED 8900/);
});

test("fluid deficits retain their measured direction and amount", () => {
	const lost = bundleWith({ items: {}, fluids: { "fusion-plasma": { expected: 1500, actual: 0, delta: -1500 } } });
	assert.equal(lost.failureStage, "fluids");
	assert.equal(lost.selfReport.diffRows[0].delta, -1500);
	assert.match(formatExplanation(lost), /fusion-plasma.*LOST 1500/);
});

test("combined and empty diffs remain readable without classifying the cause", () => {
	const both = bundleWith({
		items: { "iron-plate": { expected: 2, actual: 1, delta: -1 } },
		fluids: { water: { expected: 2, actual: 1, delta: -1 } },
	});
	assert.equal(both.failureStage, "both");
	assert.equal(both.selfReport.diffRows.length, 2);
	assert.match(formatExplanation(both), /iron-plate/);
	assert.match(formatExplanation(both), /water/);
	const empty = bundleWith({ items: {}, fluids: {} });
	assert.equal(empty.failureStage, "none");
	assert.match(formatExplanation(empty), /no count mismatch/);
});
