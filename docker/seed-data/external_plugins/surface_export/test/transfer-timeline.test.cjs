"use strict";

const assert = require("node:assert");
const test = require("node:test");
const path = require("node:path");
const fs = require("node:fs");

const {
	buildTransferTimeline, mergeIntervals, gapsWithin, describeAttribution,
} = require("../dist/node/shared/transfer-timeline");

const FIXTURES = JSON.parse(fs.readFileSync(
	path.join(__dirname, "fixtures", "real-transfer-timelines.json"), "utf8"));
const byLabel = label => {
	const found = FIXTURES.find(f => f.label === label);
	assert.ok(found, `fixture '${label}' missing — regenerate with: node tools/surface-export/make-timeline-fixtures.mjs <surface_export_transaction_logs.json>`);
	return found;
};


test("mergeIntervals collapses overlap so time is never counted twice", () => {
	assert.deepEqual(mergeIntervals([[0, 10], [5, 20], [30, 40]]), [[0, 20], [30, 40]]);
	assert.deepEqual(mergeIntervals([[10, 20], [0, 5]]), [[0, 5], [10, 20]]);
	assert.deepEqual(mergeIntervals([[5, 5], [0, 3]]), [[0, 3]], "zero-width intervals claim nothing");
});

test("gapsWithin returns the complement, including a trailing gap", () => {
	assert.deepEqual(gapsWithin([[0, 100], [200, 300]], 500), [[100, 200], [300, 500]]);
	assert.deepEqual(gapsWithin([], 100), [[0, 100]], "no measurement means the whole span is unattributed");
	assert.deepEqual(gapsWithin([[0, 100]], 100), [], "fully covered leaves no gap");
	assert.deepEqual(gapsWithin([[0, 99]], 100), [], "sub-floor slivers are granularity, not missing measurement");
});


for (const fixture of FIXTURES) {
	test(`[${fixture.label}] attributed + residual = total, exactly`, () => {
		const { attribution } = buildTransferTimeline(fixture.events, null);
		assert.equal(
			attribution.attributedMs + attribution.residualMs, attribution.totalMs,
			"every wall-clock ms belongs to a measured span or to an explicit residual",
		);
		assert.ok(attribution.residualMs >= 0, "residual can never be negative");
	});

	test(`[${fixture.label}] no measured span overlaps another`, () => {
		const { rows } = buildTransferTimeline(fixture.events, null);
		const measured = rows.filter(r => r.kind === "measured").sort((a, b) => a.startMs - b.startMs);
		for (let i = 1; i < measured.length; i++) {
			assert.ok(
				measured[i].startMs >= measured[i - 1].endMs - 0.0001,
				`measured spans overlap: '${measured[i - 1].label}' [${measured[i - 1].startMs},${measured[i - 1].endMs}] `
				+ `vs '${measured[i].label}' [${measured[i].startMs},${measured[i].endMs}] — `
				+ "overlapping wall-clock bars double-count the same milliseconds",
			);
		}
	});

	test(`[${fixture.label}] no negative span, and nothing escapes the timeline`, () => {
		const { rows, totalMs } = buildTransferTimeline(fixture.events, null);
		for (const row of rows) {
			assert.ok(row.endMs >= row.startMs, `'${row.label}' ends before it starts`);
			assert.ok(row.startMs >= -0.0001, `'${row.label}' starts before the transfer (${row.startMs}ms)`);
			assert.ok(row.startMs <= totalMs + 0.0001, `'${row.label}' starts after the transfer ends`);
			if (row.durationMs !== null) assert.ok(row.durationMs >= 0, `'${row.label}' has negative duration`);
		}
	});

	test(`[${fixture.label}] overlap trimming stays at clock-skew scale`, () => {
		const { attribution } = buildTransferTimeline(fixture.events, null);
		assert.ok(
			attribution.overlapTrimmedMs <= 5,
			`trimmed ${attribution.overlapTrimmedMs}ms of overlap between measured spans — `
			+ "at this scale the spans are double-counting real time, not sampling jitter",
		);
	});

	test(`[${fixture.label}] residual rows are exactly the uncovered gaps`, () => {
		const { rows, attribution } = buildTransferTimeline(fixture.events, null);
		const residualSum = rows.filter(r => r.kind === "residual")
			.reduce((sum, r) => sum + (r.endMs - r.startMs), 0);
		assert.ok(
			residualSum <= attribution.residualMs + 0.0001,
			"a residual row must never claim more than the unattributed total",
		);
	});
}


test("the measured destination-import window is drawn, not suppressed by the tick-derived gate", () => {
	const fixture = byLabel("workhorse-120kb");
	const { rows } = buildTransferTimeline(fixture.events, null);

	const destImport = rows.find(r => r.label === "Destination import");
	assert.ok(destImport, "the controller's wall-clock wait for the destination must appear as a span");
	assert.equal(destImport.kind, "measured");
	assert.ok(
		destImport.durationMs > 10_000,
		`the workhorse import takes >10 s of wall clock; got ${destImport.durationMs}ms — `
		+ "if this is ~0 the measured span has been replaced by the tick-derived gate again",
	);

	const gate = rows.find(r => r.label === "Validation gate");
	assert.ok(gate, "the tick-derived gate span must still be shown");
	assert.equal(gate.kind, "tickDerived");
	assert.notEqual(gate.label, destImport.label, "the two quantities must not share a name");
});

test("tick-derived spans never claim measured wall-clock time", () => {
	const events = [
		{ eventType: "transfer_created", elapsedMs: 0 },
		{ eventType: "import_started", elapsedMs: 100 },
		{
			eventType: "validation_received", elapsedMs: 5000,
			importMetrics: {
				total_ms: 200,
				phaseSpans: [
					{ name: "entities", startOffsetMs: 0, durationMs: 100 },
					{ name: "belts", startOffsetMs: 100, durationMs: 100 },
				],
			},
		},
	];
	const { attribution } = buildTransferTimeline(events, null);
	assert.equal(attribution.attributedMs, 0,
		"no wall-clock span was measured here, so nothing may be reported as attributed");
	assert.ok(attribution.residualPct > 99,
		`a timeline of only tick-derived spans is unattributed, not accounted for; got ${attribution.residualPct.toFixed(1)}%`);
});

test("the workhorse's tick-derived import spans are a small fraction of its measured window", () => {
	const fixture = byLabel("workhorse-120kb");
	const { rows } = buildTransferTimeline(fixture.events, null);
	const destImport = rows.find(r => r.label === "Destination import");
	const tickSpans = rows.filter(r => r.kind === "tickDerived" && r.indent === 2);
	assert.ok(tickSpans.length > 0, "the import phase breakdown must still be present");
	const tickTotal = tickSpans.reduce((sum, r) => sum + (r.durationMs || 0), 0);
	assert.ok(
		tickTotal < destImport.durationMs / 5,
		`tick-derived phases (${tickTotal}ms) should be far short of the measured window `
		+ `(${destImport.durationMs}ms) on this fixture — they count ticks, not elapsed time`,
	);
});

test("import phases never escape the measured window they describe", () => {
	for (const fixture of FIXTURES) {
		const { rows } = buildTransferTimeline(fixture.events, null);
		const window = rows.find(r => r.kind === "measured" && r.label === "Destination import");
		if (!window) continue;
		for (const row of rows.filter(r => r.kind === "tickDerived" && r.key.startsWith("import:"))) {
			assert.ok(
				row.startMs >= window.startMs - 0.0001 && row.endMs <= window.endMs + 0.0001,
				`[${fixture.label}] '${row.label}' [${row.startMs},${row.endMs}] escapes the measured `
				+ `import window [${window.startMs},${window.endMs}]`,
			);
		}
	}
});

test("the export tick estimate is drawn before transfer_created, not after the import", () => {
	const fixture = byLabel("workhorse-120kb");
	const { rows } = buildTransferTimeline(fixture.events, null);
	const created = rows.find(r => r.kind === "event" && r.label === "transfer_created");
	assert.ok(created, "fixture must contain transfer_created");
	for (const row of rows.filter(r => /async export/i.test(r.label))) {
		assert.ok(
			row.endMs <= created.endMs + 0.0001,
			`'${row.label}' ends at ${row.endMs}ms, after transfer_created at ${created.endMs}ms — `
			+ "the export finishes BEFORE the transfer record exists; drawing it later inverts the timeline",
		);
	}
	assert.equal(
		rows.filter(r => /export tick estimate/i.test(r.label)).length, 0,
		"exportTickEstimateMs must not be redrawn from the transfer_completed phase bag",
	);
});

test("the understatement is drawn, counted, and headlined by threshold — not by a blanket banner", () => {
	const fixture = byLabel("workhorse-120kb");
	const { rows, attribution } = buildTransferTimeline(fixture.events, null);

	assert.ok(attribution.detailGapPct > 50,
		`expected most of the measured import window to lack phase detail; got ${attribution.detailGapPct.toFixed(1)}%`);
	assert.ok(rows.some(r => r.kind === "detailGap"), "the gap must be drawn, not only counted");

	const notice = describeAttribution(attribution);
	assert.ok(notice === null || !/phase detail/i.test(notice.headline),
		"the percentage banner is retired; quantization is a gray row, the finding is the threshold headline");
	const anomaly = describeImportGapAnomaly(attribution);
	assert.ok(anomaly, "a 21.6 s destination gap must still be reported — as a threshold headline");
	assert.match(anomaly.headline, /Destination import/);

	assert.ok(attribution.residualPct <= 5,
		"the import window is measured, so its detail gap must not also count as unattributed");
});

test("describeAttribution reports residual only; detail gaps are no longer its business", () => {
	assert.equal(describeAttribution({
		totalMs: 1000, attributedMs: 1000, residualMs: 0, residualPct: 0,
		overlapTrimmedMs: 0, detailGapMs: 0, detailGapPct: 0,
	}), null);
	const both = describeAttribution({
		totalMs: 100_000, attributedMs: 94_000, residualMs: 6_000, residualPct: 6,
		overlapTrimmedMs: 0, detailGapMs: 21_000, detailGapPct: 98,
	});
	assert.match(both.headline, /unattributed/i);
	assert.doesNotMatch(both.detail, /no phase detail/i, "the detail-gap notice is gone from this describer");
});

test("truncated timelines never fabricate wall clock from tick counts", () => {
	const fixture = byLabel("workhorse-120kb");
	const truncated = fixture.events.filter(e => e.eventType !== "transfer_completed");
	const lastEventMs = Math.max(...truncated.map(e => e.elapsedMs ?? 0));
	const { totalMs, rows } = buildTransferTimeline(truncated, null);
	assert.equal(totalMs, lastEventMs,
		`the axis must end at the last real event (${lastEventMs}ms), not at a tick-derived offset (got ${totalMs}ms)`);
	assert.ok(
		!rows.some(r => r.kind === "residual" && r.endMs > lastEventMs + 0.0001),
		"no residual row may claim time past the last real event",
	);
});

test("a window with no phase breakdown gets no fabricated detail-gap row", () => {
	const fixture = byLabel("failed-timeout");
	const { rows, attribution } = buildTransferTimeline(fixture.events, null);
	assert.equal(rows.filter(r => r.kind === "detailGap").length, 0,
		"no detailGap rows may exist when no tick-derived children were reported");
	assert.equal(attribution.detailGapMs, 0, "a breakdown-less window contributes no detail gap");
});

test("the export envelope owes a detail gap too, and the async bar sits inside it", () => {
	const fixture = byLabel("workhorse-120kb");
	const { rows, attribution } = buildTransferTimeline(fixture.events, null);
	const lock = rows.find(r => r.key.startsWith("export:call:"));
	const store = rows.find(r => r.key.startsWith("export:store:"));
	const asyncBar = rows.find(r => r.key.startsWith("export:async:"));
	assert.ok(lock && store && asyncBar, "workhorse fixture must carry the full export block");
	assert.ok(
		asyncBar.startMs >= lock.startMs - 0.0001 && asyncBar.endMs <= store.endMs + 0.0001,
		"the async bar must sit inside the lock+store envelope",
	);
	const exportGaps = rows.filter(r => r.kind === "detailGap" && r.startMs >= lock.startMs - 0.0001 && r.endMs <= store.endMs + 0.0001);
	assert.ok(exportGaps.length > 0,
		"the export envelope's unbroken remainder must be drawn as a detail gap");
	const importWindow = rows.find(r => r.label === "Destination import");
	const importGapMs = rows.filter(r => r.kind === "detailGap"
		&& r.startMs >= importWindow.startMs - 0.0001 && r.endMs <= importWindow.endMs + 0.0001)
		.reduce((sum, r) => sum + (r.endMs - r.startMs), 0);
	const exportGapMs = exportGaps.reduce((sum, r) => sum + (r.endMs - r.startMs), 0);
	assert.ok(Math.abs(attribution.detailGapMs - importGapMs - exportGapMs) < 1,
		"detailGapMs must be exactly the sum of the drawn gap rows across both windows");
});

test("a measured span fully contained in another is trimmed and counted", () => {
	const events = [
		{ eventType: "transfer_created", elapsedMs: 0 },
		{ eventType: "import_started", elapsedMs: 1000, transmissionMs: 1000 },
		{ eventType: "validation_received", elapsedMs: 800, validationMs: 500 },
	];
	const { rows, attribution } = buildTransferTimeline(events, null);
	assert.equal(attribution.overlapTrimmedMs, 500,
		`the contained span's full width must be counted as trimmed (got ${attribution.overlapTrimmedMs}ms)`);
	const measured = rows.filter(r => r.kind === "measured").sort((a, b) => a.startMs - b.startMs);
	for (let i = 1; i < measured.length; i++) {
		assert.ok(measured[i].startMs >= measured[i - 1].endMs - 0.0001,
			"after trimming, no two measured bars may still overlap");
	}
});

test("detailedSummary.export supplies the export block when the event carries no exportMetrics", () => {
	const events = [
		{ eventType: "transfer_created", elapsedMs: 2000 },
		{ eventType: "transfer_completed", elapsedMs: 3000 },
	];
	const summary = { export: { requestExportAndLockMs: 400, waitForControllerStoreMs: 1100, instanceAsyncExportMs: 450, instanceAsyncExportTicks: 27 } };
	const { rows } = buildTransferTimeline(events, summary);
	assert.ok(rows.some(r => r.key.startsWith("export:call:")), "call span must come from detailedSummary.export");
	assert.ok(rows.some(r => r.key.startsWith("export:async:")), "async bar must come from detailedSummary.export");
});

test("a failed transfer still attributes its time", () => {
	const fixture = byLabel("failed-timeout");
	const { rows, attribution } = buildTransferTimeline(fixture.events, null);
	assert.equal(attribution.attributedMs + attribution.residualMs, attribution.totalMs);
	assert.ok(rows.some(r => r.kind === "event" && r.label === "transfer_failed"), "failure markers survive");
	assert.ok(rows.every(r => r.endMs >= r.startMs), "no inverted span on the rollback path");

	assert.ok(attribution.residualPct > 50,
		"the post-settle wait for a late verdict is real empty time and must read as unattributed");
});

test("the destination-gap headline stays quiet on healthy sub-second transfers and fires on the workhorse", () => {
	for (const label of ["tiny-2kb", "omnibus-87kb"]) {
		const { attribution } = buildTransferTimeline(byLabel(label).events, null);
		assert.equal(
			describeImportGapAnomaly(attribution), null,
			`[${label}] headlined a ${Math.round(attribution.importDetailGapMs)}ms detail gap — `
			+ "below the threshold, this is tick resolution, not a finding",
		);
	}
	const workhorse = describeImportGapAnomaly(buildTransferTimeline(byLabel("workhorse-120kb").events, null).attribution);
	assert.ok(workhorse, "a 21.6 s gap must still be reported");
	assert.match(workhorse.headline, /Destination import ran .* with only .* tick-attributed/);
});

test("an empty timeline is a zero, not a crash", () => {
	for (const input of [[], null, undefined]) {
		const { totalMs, rows, attribution } = buildTransferTimeline(input, null);
		assert.equal(totalMs, 0);
		assert.deepEqual(rows, []);
		assert.equal(attribution.residualPct, 0, "0/0 must not become NaN");
	}
});


const {
	describeSourceExportAnomaly, describeImportGapAnomaly, SOURCE_EXPORT_ANOMALY_MS,
} = require("../dist/node/shared/transfer-timeline");

const STALL_METRICS = {
	requestExportAndLockMs: 28126, waitForControllerStoreMs: 1404,
	instanceAsyncExportMs: 450, instanceAsyncExportTicks: 27, controllerExportPrepTotalMs: 29530,
};
const FAST_METRICS = {
	requestExportAndLockMs: 278, waitForControllerStoreMs: 1606,
	instanceAsyncExportMs: 450, instanceAsyncExportTicks: 27, controllerExportPrepTotalMs: 1884,
};

function transferEvents({ metrics, anchored, returnedAt }) {
	const createdAt = metrics.controllerExportPrepTotalMs;
	const events = [];
	if (anchored) {
		events.push({ eventType: "export_requested", elapsedMs: 0 });
		events.push({ eventType: "export_returned", elapsedMs: returnedAt ?? metrics.requestExportAndLockMs });
	}
	events.push(
		{ eventType: "transfer_created", elapsedMs: createdAt, exportMetrics: metrics },
		{ eventType: "import_started", elapsedMs: createdAt + 372, transmissionMs: 370 },
		{ eventType: "validation_received", elapsedMs: createdAt + 1875, validationMs: 1503 },
		{ eventType: "transfer_completed", elapsedMs: createdAt + 1971, phases: { cleanupMs: 95 } },
	);
	return events;
}
const rowNamed = (rows, label) => rows.find(r => r.label === label);

test("anchored: the source export call spans exactly export_requested → export_returned", () => {
	const { rows, attribution } = buildTransferTimeline(transferEvents({ metrics: STALL_METRICS, anchored: true }), null);
	const call = rowNamed(rows, "Source export call");
	assert.ok(call, "call row present");
	assert.equal(call.startMs, 0);
	assert.equal(call.endMs, 28126);
	assert.equal(call.kind, "measured");
	const store = rowNamed(rows, "Wait for store");
	assert.equal(store.startMs, 28126);
	assert.equal(store.endMs, 29530);
	assert.equal(attribution.sourceExportAnchored, true);
	assert.equal(attribution.sourceExportCallMs, 28126);
	assert.equal(rows.some(r => r.kind === "event" && /export_requested|export_returned/.test(r.label)), false,
		"anchor events become the span, not two more marker rows");
});

test("MUTATION KILL: when the anchor disagrees with the metric, the anchor wins", () => {
	const { rows, attribution } = buildTransferTimeline(
		transferEvents({ metrics: STALL_METRICS, anchored: true, returnedAt: 20000 }), null);
	assert.equal(rowNamed(rows, "Source export call").endMs, 20000);
	assert.equal(rowNamed(rows, "Wait for store").startMs, 20000);
	assert.equal(attribution.sourceExportCallMs, 20000);
});

test("legacy log without anchor events back-computes the same call window from requestExportAndLockMs", () => {
	const { rows, attribution } = buildTransferTimeline(transferEvents({ metrics: STALL_METRICS, anchored: false }), null);
	const call = rowNamed(rows, "Source export call");
	assert.equal(call.startMs, 0);
	assert.equal(call.endMs, 28126);
	assert.equal(attribution.sourceExportAnchored, false);
	assert.equal(attribution.sourceExportCallMs, 28126);
});

test("the async export sits in the store-wait window, after the synchronous call returns", () => {
	const { rows } = buildTransferTimeline(transferEvents({ metrics: STALL_METRICS, anchored: true }), null);
	const asyncRow = rows.find(r => /^Async export/.test(r.label));
	assert.equal(asyncRow.startMs, 28126);
	assert.equal(asyncRow.endMs, 28576);
	assert.equal(asyncRow.kind, "tickDerived");
});

test("source export anomaly: the 28.1 s call is headlined, the 278 ms call is silent", () => {
	const stall = buildTransferTimeline(transferEvents({ metrics: STALL_METRICS, anchored: true }), null).attribution;
	const anomaly = describeSourceExportAnomaly(stall);
	assert.ok(anomaly, "28.1 s call must produce an anomaly");
	assert.match(anomaly.headline, /28[.,]1/);
	assert.match(anomaly.headline, /synchronous export call/);
	assert.match(anomaly.detail, /27 ticks/);
	const fast = buildTransferTimeline(transferEvents({ metrics: FAST_METRICS, anchored: true }), null).attribution;
	assert.equal(describeSourceExportAnomaly(fast), null, "a 278 ms call is normal");
	assert.ok(FAST_METRICS.requestExportAndLockMs < SOURCE_EXPORT_ANOMALY_MS && STALL_METRICS.requestExportAndLockMs >= SOURCE_EXPORT_ANOMALY_MS,
		"the two pins straddle the threshold, so the test exercises both sides of it");
});

test("MUTATION KILL: a call exactly at the threshold is headlined; one millisecond under is not", () => {
	const at = { ...FAST_METRICS, requestExportAndLockMs: SOURCE_EXPORT_ANOMALY_MS, controllerExportPrepTotalMs: SOURCE_EXPORT_ANOMALY_MS + 1606 };
	const under = { ...FAST_METRICS, requestExportAndLockMs: SOURCE_EXPORT_ANOMALY_MS - 1, controllerExportPrepTotalMs: SOURCE_EXPORT_ANOMALY_MS + 1605 };
	assert.ok(describeSourceExportAnomaly(buildTransferTimeline(transferEvents({ metrics: at, anchored: true }), null).attribution));
	assert.equal(describeSourceExportAnomaly(buildTransferTimeline(transferEvents({ metrics: under, anchored: true }), null).attribution), null);
});

test("gap rows are labeled 'Not tick-attributed'; 'No phase detail' is gone and no longer raises a notice", () => {
	const { rows, attribution } = buildTransferTimeline(transferEvents({ metrics: STALL_METRICS, anchored: true }), null);
	assert.equal(rows.some(r => r.label === "No phase detail"), false);
	assert.ok(rows.some(r => r.kind === "detailGap" && r.label === "Not tick-attributed"), "the synchronous call window is a gap row");
	const notice = describeAttribution(attribution);
	assert.equal(notice === null || !/no phase detail/i.test(notice.headline), true);
});
