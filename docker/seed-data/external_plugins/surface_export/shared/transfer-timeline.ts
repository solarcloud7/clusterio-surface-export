// Transfer Flow timeline assembly.
//
// Lives in shared/ (not web/) for the same reason as revision-gate.ts: tsconfig.node.json excludes
// web/**, so a rule that lives there is unreachable from `npm test`, which only sees dist/node.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: a bar's width on the wall-clock axis must be a wall-clock
// measurement. Every other quantity is drawn, named and coloured as something else.
//
// Two clocks feed this chart and they are not interchangeable:
//
//   WALL CLOCK   Date.now() deltas taken on the controller (transmissionMs, validationMs, the
//                export prep/lock/store trio, cleanupMs). These are real elapsed time.
//   TICK-DERIVED `game.tick` deltas scaled by a nominal 60 UPS (every import phaseSpan, every
//                *_ticks/_ms pair, instanceAsyncExportMs, exportTickEstimateMs). These count TICKS.
//                A tick is not 16.67 ms when the game is busy: it is however long its work takes.
//
// Measured on this cluster (2026-08-09, 120 KB lab-transfer-fixture-v1, host-2 factorio-current.log):
// the import job was created at log t=47.988 and completed at t=63.502 — 15.5 s of real time — while
// its own instrument reported 28 ticks = 467 ms. A 33x understatement, and the log line the game
// prints ("1359 entities in 0.5s") inherits it. One single tick spanned 62.280 -> 63.494 = 1.2 s.
// The destination idles at a healthy 60 UPS, so this is the import stalling the server, not a slow
// host. Drawing those 467 ms as if they were the 15.5 s window is the defect this file removes.
//
// So tick-derived spans keep their tick-derived WIDTH and sit inside the measured window they belong
// to. The time they cannot account for becomes an explicit `residual` row rather than silently
// inflating a neighbour or hiding in a muted "Round-trip" bar. Unmeasured is not zero, and in the
// time domain it is not somebody else's milliseconds either.

export type TimelineEventInput = {
	eventType?: string;
	elapsedMs?: number;
	transmissionMs?: number;
	validationMs?: number;
	phases?: Record<string, unknown>;
	exportMetrics?: Record<string, unknown> | null;
	importMetrics?: Record<string, unknown> | null;
	[key: string]: unknown;
};

/**
 * `measured`     wall-clock; may claim width on the axis.
 * `tickDerived`  a tick count scaled by a nominal 60 UPS; width is NOT elapsed time.
 * `residual`     measured time no span accounts for. Never a real phase — always a gap.
 * `detailGap`    measured time INSIDE a measured span that its tick-derived breakdown does not
 *                reach. The parent is measured, so this is not unattributed wall clock — it is
 *                wall clock with no phase detail, and it is where the understatement shows.
 * `event`        zero-width marker.
 */
export type SpanKind = "measured" | "tickDerived" | "residual" | "detailGap" | "event";

export type TimelineRow = {
	key: string;
	label: string;
	isEvent: boolean;
	indent: number;
	startMs: number;
	endMs: number;
	durationMs: number | null;
	color: string;
	kind: SpanKind;
	/** Shown on hover. States what BOUNDS the row, never a cause we did not measure. */
	note?: string;
};

export type TimelineAttribution = {
	totalMs: number;
	/** Wall-clock ms covered by at least one measured span. */
	attributedMs: number;
	/** Wall-clock ms inside the transfer that no measured span covers. */
	residualMs: number;
	residualPct: number;
	/**
	 * Total ms trimmed to stop adjacent measured spans overlapping. Adjacent phases are bracketed by
	 * SEPARATE Date.now() samples, so a handoff can read as a sub-millisecond overlap (measured: 1 ms
	 * between Transmission and Destination import on a real 28.5 s transfer). Trimming keeps the bars
	 * tiling; publishing the amount keeps it honest — a large value means the MODEL is wrong, not the
	 * clock, and the tests assert it stays negligible on real transfers.
	 */
	overlapTrimmedMs: number;
	/**
	 * Measured ms inside the destination-import window that its tick-derived phase breakdown does not
	 * reach. This is the understatement itself, as a number: the window is real elapsed time, the
	 * phases inside it count ticks, and a tick that runs long moves the former and not the latter.
	 */
	detailGapMs: number;
	/** detailGapMs as a share of the measured window it sits in — 0 when there is no such window. */
	detailGapPct: number;
};

export type TransferTimeline = {
	totalMs: number;
	rows: TimelineRow[];
	attribution: TimelineAttribution;
};

/** Anything above this share is worth saying out loud rather than leaving to be noticed. */
const NOTICE_THRESHOLD_PCT = 5;

function formatMs(ms: number) {
	return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/**
 * The one wording for "this chart cannot account for its own time", so the browser tab and the
 * offline preview cannot drift into describing the same numbers differently.
 * Returns null when the timeline accounts for itself.
 */
export function describeAttribution(attribution: TimelineAttribution): { headline: string; detail: string } | null {
	if (attribution.residualPct > NOTICE_THRESHOLD_PCT) {
		return {
			headline: `${formatMs(attribution.residualMs)} of ${formatMs(attribution.totalMs)} `
				+ `(${attribution.residualPct.toFixed(0)}%) is unattributed`,
			detail: "No measured span covers this time. It is bounded by the spans on either side of it.",
		};
	}
	if (attribution.detailGapPct > NOTICE_THRESHOLD_PCT) {
		return {
			headline: `${formatMs(attribution.detailGapMs)} of the destination import `
				+ `(${attribution.detailGapPct.toFixed(0)}%) has no phase detail`,
			detail: "The import window is measured wall clock, but the phases inside it are game.tick "
				+ "deltas scaled by a nominal 60 UPS. A tick that runs long does not widen them, so the "
				+ "breakdown stops short of the window it sits in. The amber bar is the difference, not idle time.",
		};
	}
	return null;
}

/** Gaps below this are rendering noise (clock granularity), not missing measurement. */
const RESIDUAL_FLOOR_MS = 2;

function finite(value: unknown): number | null {
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

function positive(value: unknown): number | null {
	const n = finite(value);
	return n !== null && n > 0 ? n : null;
}

/** Merge overlapping/touching intervals so attributed time is counted once, never twice. */
export function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
	const sorted = intervals
		.filter(([a, b]) => b > a)
		.sort((x, y) => x[0] - y[0]);
	const merged: Array<[number, number]> = [];
	for (const [start, end] of sorted) {
		const last = merged[merged.length - 1];
		if (last && start <= last[1]) {
			last[1] = Math.max(last[1], end);
		} else {
			merged.push([start, end]);
		}
	}
	return merged;
}

/** The complement of `covered` within [0, totalMs] — where the unattributed time actually sits. */
export function gapsWithin(covered: Array<[number, number]>, totalMs: number): Array<[number, number]> {
	const gaps: Array<[number, number]> = [];
	let cursor = 0;
	for (const [start, end] of mergeIntervals(covered)) {
		if (start > cursor) gaps.push([cursor, Math.min(start, totalMs)]);
		cursor = Math.max(cursor, end);
	}
	if (cursor < totalMs) gaps.push([cursor, totalMs]);
	return gaps.filter(([a, b]) => b - a > RESIDUAL_FLOOR_MS);
}

const IMPORT_SPAN_LABELS: Record<string, string> = {
	delivery: "Delivery", queue: "Queue wait", tiles: "Tiles", entities: "Entities",
	fluids: "Fluids", belts: "Belts", state: "State", inventories: "Inventories",
	hub: "Hub", held_items: "Held items", activation: "Activation",
	loss_analysis: "Loss analysis", queue_setup: "Queue setup", beacons: "Beacons",
	// The gate, NOT the controller's wait for it. The two used to share the name "Validation";
	// the collision let a 0 ms tick-derived span suppress a 15 s measured one (see buildTransferTimeline).
	validation: "Validation gate",
};

function humanize(key: string) {
	return String(key)
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.replace(/^./, c => c.toUpperCase());
}

/**
 * Assemble the transfer timeline. Pure: no clock, no DOM, no I/O — so `npm test` can pin its
 * invariants against real recorded transfers.
 */
export function buildTransferTimeline(
	events: readonly TimelineEventInput[] | null | undefined,
	detailedSummary: Record<string, unknown> | null,
): TransferTimeline {
	const rows: TimelineRow[] = [];
	// The import phase breakdown, tracked explicitly. Selecting it later by indent would also catch
	// the export's async sub-bar, which is likewise tick-derived and likewise indented — that mistake
	// clamped the export INTO the import window and inverted the timeline.
	const importPhaseRows: TimelineRow[] = [];
	const list = (events || []).filter(Boolean);
	let totalMs = 0;

	const eventAt: Record<string, number> = {};
	for (const ev of list) {
		const at = finite(ev.elapsedMs);
		if (at !== null && ev.eventType) eventAt[String(ev.eventType)] = at;
	}


	for (const event of list) {
		const at = finite(event.elapsedMs) ?? 0;
		const type = String(event.eventType || "event");
		const isFailure = /failed|error|timeout/.test(type);
		const isSuccess = /completed|success/.test(type);

		rows.push({
			key: `event:${type}:${at}`, label: type, isEvent: true, indent: 0,
			startMs: at, endMs: at, durationMs: null,
			color: isFailure ? "red" : isSuccess ? "green" : "blue", kind: "event",
		});
		totalMs = Math.max(totalMs, at);

		// ---- Export block. Ends at transfer_created, so it is laid BACKWARD from this event. ----
		const exportMetrics = (event.exportMetrics
			|| (type === "transfer_created" ? (detailedSummary?.export as Record<string, unknown>) : null)) as
			Record<string, unknown> | null;
		if (exportMetrics) {
			// Wall clock (controller Date.now deltas). Only present when the CONTROLLER drove the export.
			const lockMs = finite(exportMetrics.requestExportAndLockMs) ?? 0;
			const storeMs = finite(exportMetrics.waitForControllerStoreMs) ?? 0;
			const lockEnd = at - storeMs;
			const lockStart = lockEnd - lockMs;
			if (lockMs > 0) {
				rows.push({
					key: `export:lock:${at}`, label: "Request export + lock source", isEvent: false, indent: 1,
					startMs: lockStart, endMs: lockEnd, durationMs: lockMs, color: "exportQueue", kind: "measured",
					note: "Controller wall clock: export request through source lock.",
				});
			}
			if (storeMs > 0) {
				rows.push({
					key: `export:store:${at}`, label: "Wait for store", isEvent: false, indent: 1,
					startMs: lockEnd, endMs: at, durationMs: storeMs, color: "exportStore", kind: "measured",
					note: "Controller wall clock: waiting for the export to land in the controller store.",
				});
			}
			// Tick-derived: math.floor(duration_ticks * 16.67) from export-pipeline.lua. Structurally
			// blind to a tick stall — it cannot grow when the game slows down. Drawn at the export's
			// real position (before transfer_created) rather than back-anchored to transfer_completed,
			// where it used to sit: the export finishes BEFORE the transfer record exists.
			const asyncMs = positive(exportMetrics.instanceAsyncExportMs);
			const ticks = positive(exportMetrics.instanceAsyncExportTicks);
			if (asyncMs !== null) {
				const asyncEnd = lockMs > 0 ? lockEnd : at;
				rows.push({
					key: `export:async:${at}`, label: ticks !== null
						? `Async export (${ticks.toLocaleString()} ticks)` : "Async export",
					isEvent: false, indent: lockMs > 0 ? 2 : 1,
					startMs: Math.max(0, asyncEnd - asyncMs), endMs: asyncEnd,
					durationMs: asyncMs, color: "exportAsync", kind: "tickDerived",
					note: `${ticks ?? "?"} ticks x 16.67 ms nominal — a tick count, not elapsed time.`,
				});
			}
		}

		// ---- Transmission: controller -> destination, INCLUDING the destination's RCON chunk feed. ----
		// The destination awaits its whole chunk feed inside this request, so the payload upload is
		// already inside this measured span. (Measured: 114-346 ms for a 120 KB payload — the upload
		// is not the dominant cost this chart was once thought to be hiding.)
		const transmissionMs = positive(event.transmissionMs);
		if (transmissionMs !== null) {
			rows.push({
				key: `phase:transmission:${at}`, label: "Transmission + payload upload", isEvent: false, indent: 1,
				startMs: at - transmissionMs, endMs: at, durationMs: transmissionMs,
				color: "transmission", kind: "measured",
				note: "Controller wall clock: import request sent until the destination accepted it (its RCON chunk feed runs inside).",
			});
		}

		// ---- Destination import window: the controller's wall-clock wait. ----
		// This is the honest elapsed time for everything the destination does — receive, restore,
		// gate. It used to be SUPPRESSED whenever the import reported a tick-derived span also named
		// "validation", so a 0 ms tick span hid a 15 s measured one. The two are different quantities
		// and now carry different names.
		const validationMs = positive(event.validationMs);
		if (validationMs !== null) {
			const start = at - validationMs;
			rows.push({
				key: `phase:destimport:${at}`, label: "Destination import", isEvent: false, indent: 1,
				startMs: start, endMs: at, durationMs: validationMs, color: "destImport", kind: "measured",
				note: "Controller wall clock: destination accepted the import until its verdict arrived.",
			});
		}

		// ---- Import phases: tick-derived, nested INSIDE the measured window above. ----
		const importMetrics = event.importMetrics as Record<string, unknown> | null;
		if (importMetrics) {
			const spans = Array.isArray(importMetrics.phaseSpans)
				? importMetrics.phaseSpans as Array<Record<string, unknown>> : null;
			const importStarted = finite(eventAt["import_started"]);
			const segStart = importStarted !== null ? importStarted : at - (finite(importMetrics.total_ms) ?? 0);
			const counts: Record<string, unknown> = {
				tiles: importMetrics.tiles_placed, entities: importMetrics.entities_created,
				fluids: importMetrics.fluids_restored, belts: importMetrics.belt_items_restored,
				state: importMetrics.circuits_connected,
			};
			if (spans && spans.length) {
				const pushImportPhase = (row: TimelineRow) => { rows.push(row); importPhaseRows.push(row); };
				for (const span of [...spans].sort((a, b) => (finite(a.startOffsetMs) ?? 0) - (finite(b.startOffsetMs) ?? 0))) {
					const name = String(span.name || "phase");
					const startMs = segStart + (finite(span.startOffsetMs) ?? 0);
					const dur = finite(span.durationMs) ?? 0;
					const count = positive(counts[name]);
					const base = IMPORT_SPAN_LABELS[name] || humanize(name);
					pushImportPhase({
						key: `import:${name}:${at}`, label: count !== null ? `${base} (${count.toLocaleString()})` : base,
						isEvent: false, indent: 2,
						// Floor to 1 ms so a sub-tick phase stays visible as a sliver rather than vanishing.
						startMs, endMs: startMs + Math.max(dur, 1), durationMs: dur || null,
						color: name, kind: "tickDerived",
						note: dur === 0
							? "Under one tick — below what game.tick can resolve, not instant."
							: "Tick count x 16.67 ms nominal — not elapsed time.",
					});
					totalMs = Math.max(totalMs, startMs + Math.max(dur, 1));
				}
			}
		}

		// ---- Remaining wall-clock phases carried on transfer_completed. ----
		if (event.phases && typeof event.phases === "object") {
			for (const [key, value] of Object.entries(event.phases as Record<string, unknown>)) {
				// Drawn above at their true positions from the events that carry them.
				if (key === "transmissionMs" || key === "validationMs") continue;
				// A tick estimate, already drawn inside the export block at the export's real position.
				// Redrawing it here back-anchored to transfer_completed put the export AFTER the import.
				if (key === "exportTickEstimateMs" || key === "exportMs") continue;
				const ms = positive(value);
				if (ms === null) continue;
				const name = key.replace(/Ms$/, "");
				rows.push({
					key: `phase:${key}:${at}`, label: humanize(name), isEvent: false, indent: 1,
					startMs: at - ms, endMs: at, durationMs: ms, color: name, kind: "measured",
					note: "Controller wall clock.",
				});
			}
		}
	}

	// ---- Attribution: every measured ms belongs to a named span, or to an explicit residual. ----
	// Tile the measured spans first. `measured` recorded the intervals as they were pushed; the rows
	// themselves are the ones drawn, so trim THEM and derive the intervals from the trimmed rows —
	// otherwise attribution and the picture could disagree.
	let overlapTrimmedMs = 0;
	const measuredRows = rows.filter(row => row.kind === "measured").sort((a, b) => a.startMs - b.startMs);
	let priorEnd = 0;
	for (const row of measuredRows) {
		if (row.startMs < priorEnd && row.endMs > priorEnd) {
			overlapTrimmedMs += priorEnd - row.startMs;
			row.startMs = priorEnd;
			row.durationMs = row.endMs - row.startMs;
		}
		priorEnd = Math.max(priorEnd, row.endMs);
	}

	const covered = mergeIntervals(measuredRows.map(row => [row.startMs, row.endMs] as [number, number]))
		.map(([a, b]) => [Math.max(0, a), Math.min(b, totalMs)] as [number, number]);
	for (const [start, end] of gapsWithin(covered, totalMs)) {
		rows.push({
			key: `residual:${start}`, label: "Unattributed", isEvent: false, indent: 1,
			startMs: start, endMs: end, durationMs: end - start, color: "residual", kind: "residual",
			note: "Wall-clock time no measured span covers. Bounded by the spans on either side.",
		});
	}

	// ---- Detail gap: measured import window minus what its tick-derived phases reach. ----
	// Without this the chart looks fully attributed — a 22 s measured bar with 0.5 s of hatched
	// phases at its left edge and no statement anywhere that the other 21.5 s has no breakdown.
	let detailGapMs = 0;
	let detailGapPct = 0;
	const importWindow = rows.find(row => row.kind === "measured" && row.color === "destImport");
	if (importWindow) {
		// A phase offset is a tick count, so on a short import it can land PAST the measured window it
		// describes (seen on a 7 ms import whose later phases claim a 16 ms offset — one tick). Drawing
		// it outside its own parent would say the destination worked after it reported its verdict, so
		// clamp; the width was never elapsed time, but the containment is real.
		for (const row of importPhaseRows) {
			row.startMs = Math.min(Math.max(row.startMs, importWindow.startMs), importWindow.endMs);
			row.endMs = Math.min(Math.max(row.endMs, row.startMs), importWindow.endMs);
			row.durationMs = row.durationMs === null ? null : Math.min(row.durationMs, row.endMs - row.startMs);
		}
		const inside = importPhaseRows
			.map(row => [row.startMs, row.endMs] as [number, number]);
		const windowMs = importWindow.endMs - importWindow.startMs;
		for (const [start, end] of gapsWithin(
			mergeIntervals(inside).map(([a, b]) => [a - importWindow.startMs, b - importWindow.startMs] as [number, number]),
			windowMs,
		)) {
			detailGapMs += end - start;
			rows.push({
				key: `detailgap:${start}`, label: "No phase detail", isEvent: false, indent: 2,
				startMs: importWindow.startMs + start, endMs: importWindow.startMs + end,
				durationMs: end - start, color: "residual", kind: "detailGap",
				note: "Inside the measured import window, but past where the tick-derived phases reach. "
					+ "Phase marks are game.tick deltas; a tick that runs long does not widen them.",
			});
		}
		detailGapPct = windowMs > 0 ? (detailGapMs / windowMs) * 100 : 0;
	}

	const attributedMs = mergeIntervals(covered).reduce((sum, [a, b]) => sum + (b - a), 0);
	const residualMs = Math.max(0, totalMs - attributedMs);
	rows.sort((a, b) => a.startMs - b.startMs || a.indent - b.indent);

	return {
		totalMs,
		rows,
		attribution: {
			totalMs,
			attributedMs,
			residualMs,
			residualPct: totalMs > 0 ? (residualMs / totalMs) * 100 : 0,
			overlapTrimmedMs,
			detailGapMs,
			detailGapPct,
		},
	};
}
