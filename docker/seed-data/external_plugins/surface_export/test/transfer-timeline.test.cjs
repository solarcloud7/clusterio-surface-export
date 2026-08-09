"use strict";
// Transfer Flow timeline: attribution invariants, pinned against REAL recorded transfers.
//
// The fixtures in test/fixtures/real-transfer-timelines.json are distilled from this cluster's own
// surface_export_transaction_logs.json (timing fields only). They are the reason this file can
// assert anything about the defect it was written for: a synthetic timeline would have agreed with
// whatever the builder did.
//
// The defect: import phase spans are game.tick deltas scaled by a nominal 60 UPS, and the chart drew
// them on a wall-clock axis. Measured on host-2 (120 KB lab-transfer-fixture-v1): the import ran
// 47.988 -> 63.502 in Factorio's own log = 15.5 s, while its spans reported 28 ticks = 467 ms.
// Meanwhile the honest wall-clock number (validationMs, 15.3 s) was SUPPRESSED because a 0 ms
// tick-derived span happened to share the name "validation".

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

// ---------------------------------------------------------------- interval helpers

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

// ---------------------------------------------------------------- attribution invariants

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
		// Adjacent phases are bracketed by separate Date.now() samples, so a handoff can read as a
		// sub-ms overlap; the assembly trims it so the bars tile. A LARGE trim would mean two spans
		// genuinely claim the same milliseconds — a modelling error this assertion is here to catch.
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
		// Residual rows below the 2 ms floor are dropped as granularity, so rows <= the reported total.
		assert.ok(
			residualSum <= attribution.residualMs + 0.0001,
			"a residual row must never claim more than the unattributed total",
		);
	});
}

// ---------------------------------------------------------------- the defect, pinned

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

	// The gate keeps its own name so it can never again suppress the measurement above.
	const gate = rows.find(r => r.label === "Validation gate");
	assert.ok(gate, "the tick-derived gate span must still be shown");
	assert.equal(gate.kind, "tickDerived");
	assert.notEqual(gate.label, destImport.label, "the two quantities must not share a name");
});

test("tick-derived spans never claim measured wall-clock time", () => {
	// Stated so it is OBSERVABLE. On a real transfer the tick spans nest inside a measured window, so
	// counting them would not change the merged coverage and the assertion would pass either way —
	// a tautology dressed as a guard (mutation testing caught exactly that). A timeline with tick
	// spans and NO wall-clock phase is the case that can tell the difference: if tick-derived time
	// counted as attributed, this would report itself fully accounted for.
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
	// This is the understatement itself, asserted as a property rather than as a remembered number:
	// whatever the exact ratio, the tick-derived phases must NOT be treated as covering the window.
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
	// A phase offset is a tick count. On a short import it can exceed the measured window (the 2 KB
	// fixture's window is 7 ms while later phases claim a 16 ms — one tick — offset), which would draw
	// the destination still working after it had already reported its verdict.
	for (const fixture of FIXTURES) {
		const { rows } = buildTransferTimeline(fixture.events, null);
		const window = rows.find(r => r.kind === "measured" && r.label === "Destination import");
		if (!window) continue;
		// Select import phases by key, not by indent: the export's async bar is tick-derived and
		// indented too, and selecting it here is exactly the mistake that clamped the export into
		// the import window when the production code used the same shortcut.
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
	// The duplicate back-anchored copy on transfer_completed must be gone.
	assert.equal(
		rows.filter(r => /export tick estimate/i.test(r.label)).length, 0,
		"exportTickEstimateMs must not be redrawn from the transfer_completed phase bag",
	);
});

test("the understatement is stated, not left to be noticed", () => {
	// The chart is fully attributed on the workhorse (the measured import window covers its own time),
	// so a residual check alone reports "all good" while 97% of that window has no breakdown. This is
	// the assertion that would have failed if the detail gap were dropped from the model.
	const fixture = byLabel("workhorse-120kb");
	const { rows, attribution } = buildTransferTimeline(fixture.events, null);

	assert.ok(attribution.detailGapPct > 50,
		`expected most of the measured import window to lack phase detail; got ${attribution.detailGapPct.toFixed(1)}%`);
	assert.ok(rows.some(r => r.kind === "detailGap"), "the gap must be drawn, not only counted");

	const notice = describeAttribution(attribution);
	assert.ok(notice, "a timeline that cannot break down its own dominant span must say so");
	assert.match(notice.headline, /no phase detail/i);

	// A detail gap is NOT unattributed wall clock — the parent span is measured. Conflating the two
	// would double-report the same milliseconds as missing.
	assert.ok(attribution.residualPct <= 5,
		"the import window is measured, so its detail gap must not also count as unattributed");
});

test("describeAttribution stays silent when the timeline accounts for itself", () => {
	assert.equal(describeAttribution({
		totalMs: 1000, attributedMs: 1000, residualMs: 0, residualPct: 0,
		overlapTrimmedMs: 0, detailGapMs: 0, detailGapPct: 0,
	}), null);
	// When both findings fire, the headline carries the unattributed time (the more serious one)
	// and the detail carries BOTH — a marginal residual must not suppress a dominant detail gap
	// (review 2026-08-09: a 6% residual used to hide a 21 s / 98% gap entirely).
	const both = describeAttribution({
		totalMs: 100_000, attributedMs: 94_000, residualMs: 6_000, residualPct: 6,
		overlapTrimmedMs: 0, detailGapMs: 21_000, detailGapPct: 98,
	});
	assert.match(both.headline, /unattributed/i);
	assert.match(both.detail, /no phase detail/i, "the second finding must survive into the detail text");
});

test("truncated timelines never fabricate wall clock from tick counts", () => {
	// Every live-watched transfer passes through the last-event=validation_received state (events
	// arrive one at a time), and 76/453 persisted entries end before transfer_completed. Tick-span
	// ends used to extend totalMs past the last real event, and the residual pass then invented an
	// amber "Unattributed" row over time that never existed (review 2026-08-09, CONFIRMED).
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
	// The failed-timeout fixture's import window is a controller timeout: the destination never
	// reported ANY phase spans. Emitting a full-window "No phase detail" row there claimed that
	// tick-derived phases stopped short — phases that never existed (review 2026-08-09, CONFIRMED
	// on a real 113 s timeout entry). An unbroken measured bar already says, honestly, that nothing
	// reported a breakdown.
	const fixture = byLabel("failed-timeout");
	const { rows, attribution } = buildTransferTimeline(fixture.events, null);
	assert.equal(rows.filter(r => r.kind === "detailGap").length, 0,
		"no detailGap rows may exist when no tick-derived children were reported");
	assert.equal(attribution.detailGapMs, 0, "a breakdown-less window contributes no detail gap");
});

test("the export envelope owes a detail gap too, and the async bar sits inside it", () => {
	// The export has the identical structure to the import — a measured envelope (lock + store)
	// containing a tick-derived span — and the export side is where the one MEASURED client drop
	// lives. Review 2026-08-09 (CONFIRMED): the async bar was drawn under the lock span alone
	// (the wrong parent — the async work elapses during the store wait) and the gap machinery
	// ignored the export entirely, so export-side tick understatement rendered fully attributed.
	const fixture = byLabel("workhorse-120kb");
	const { rows, attribution } = buildTransferTimeline(fixture.events, null);
	const lock = rows.find(r => r.key.startsWith("export:lock:"));
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
	// The straddle-only trim missed containment: two solid bars double-painted the same time while
	// overlapTrimmedMs read 0 — the honesty metric blind on exactly the large-overlap case it
	// exists to expose (review 2026-08-09). No current emitter produces containment, so this is a
	// synthetic input pinning the guard for the input shape the type permits.
	const events = [
		{ eventType: "transfer_created", elapsedMs: 0 },
		{ eventType: "import_started", elapsedMs: 1000, transmissionMs: 1000 },
		// A second measured span nested wholly inside the transmission span above.
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
	// The browser wrapper feeds detailedSummary; every fixture assertion passes null, so this
	// fallback branch had zero coverage (review 2026-08-09).
	const events = [
		{ eventType: "transfer_created", elapsedMs: 2000 },
		{ eventType: "transfer_completed", elapsedMs: 3000 },
	];
	const summary = { export: { requestExportAndLockMs: 400, waitForControllerStoreMs: 1100, instanceAsyncExportMs: 450, instanceAsyncExportTicks: 27 } };
	const { rows } = buildTransferTimeline(events, summary);
	assert.ok(rows.some(r => r.key.startsWith("export:lock:")), "lock span must come from detailedSummary.export");
	assert.ok(rows.some(r => r.key.startsWith("export:async:")), "async bar must come from detailedSummary.export");
});

test("a failed transfer still attributes its time", () => {
	const fixture = byLabel("failed-timeout");
	const { rows, attribution } = buildTransferTimeline(fixture.events, null);
	assert.equal(attribution.attributedMs + attribution.residualMs, attribution.totalMs);
	assert.ok(rows.some(r => r.kind === "event" && r.label === "transfer_failed"), "failure markers survive");
	assert.ok(rows.every(r => r.endMs >= r.startMs), "no inverted span on the rollback path");

	// This fixture's 87% unattributed is CORRECT and should stay. The transfer settled as failed and a
	// late verdict arrived 35 s later (validation_after_settle); nothing runs in between, so the gap is
	// genuinely empty time, not missing instrumentation. If a future change starts modelling that
	// stretch this assertion will fail — the fix is to re-read this comment, not to relax the number.
	assert.ok(attribution.residualPct > 50,
		"the post-settle wait for a late verdict is real empty time and must read as unattributed");
});

test("the detail-gap warning stays quiet on healthy sub-second transfers", () => {
	// Share alone cries wolf: a same-tick import cannot fill its window because one tick IS the
	// resolution floor, so tiny transfers report a huge PERCENTAGE over a handful of ms. A warning
	// that fires on every healthy transfer is one the owner learns to ignore.
	for (const label of ["tiny-2kb", "omnibus-87kb"]) {
		const { attribution } = buildTransferTimeline(byLabel(label).events, null);
		const notice = describeAttribution(attribution);
		assert.ok(
			notice === null || !/no phase detail/i.test(notice.headline),
			`[${label}] warned about a ${Math.round(attribution.detailGapMs)}ms detail gap — `
			+ "below the floor, this is tick resolution, not a finding",
		);
	}
	// ...and still speaks up on the one that matters.
	const workhorse = describeAttribution(buildTransferTimeline(byLabel("workhorse-120kb").events, null).attribution);
	assert.match(workhorse.headline, /no phase detail/i, "a 21.6 s gap must still be reported");
});

test("an empty timeline is a zero, not a crash", () => {
	for (const input of [[], null, undefined]) {
		const { totalMs, rows, attribution } = buildTransferTimeline(input, null);
		assert.equal(totalMs, 0);
		assert.deepEqual(rows, []);
		assert.equal(attribution.residualPct, 0, "0/0 must not become NaN");
	}
});
