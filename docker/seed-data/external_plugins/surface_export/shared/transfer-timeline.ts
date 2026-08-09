// Transfer Flow timeline assembly. Lives in shared/ (not web/) so `npm test` can reach it via
// dist/node; the browser tab, the offline preview and the tests all consume THIS module — the
// palette, the bar geometry and the wording exported below are the single copies.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: a bar's width on the wall-clock axis must be a wall-clock
// measurement. Every other quantity is drawn, named and coloured as something else.
//
// Two clocks feed this chart and they are not interchangeable:
//
//   WALL CLOCK   Date.now() deltas taken on the controller (transmissionMs, validationMs, the
//                export lock/store pair, cleanupMs). These are real elapsed time.
//   TICK-DERIVED `game.tick` deltas scaled by a nominal 60 UPS (every import phaseSpan, every
//                *_ticks/_ms pair, instanceAsyncExportMs). These count TICKS. A tick is not
//                16.67 ms when the game is busy: it is however long its work takes.
//
// Measured on this cluster (2026-08-09, 120 KB lab-transfer-fixture-v1, host-2 factorio-current.log):
// the import job was created at log t=47.988 and completed at t=63.502 — 15.5 s of real time — while
// its own instrument reported 28 ticks = 467 ms. A 33x understatement, and the log line the game
// prints ("1359 entities in 0.5s") inherits it. Drawing those 467 ms as if they were the 15.5 s
// window is the defect this file removes.
//
// So tick-derived spans keep their tick-derived WIDTH, sit inside the measured window they belong
// to, and NEVER move the axis: totalMs comes from events and measured spans only — a tick count
// that overruns its window is clamped back in, not allowed to manufacture wall-clock time past the
// last real event. The time no measured span covers becomes an explicit `residual` row; the part of
// a measured window its tick breakdown does not reach becomes a `detailGap` row. Unmeasured is not
// zero, and in the time domain it is not somebody else's milliseconds either.

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
	 * Total ms trimmed to stop measured spans double-painting the same time. Adjacent phases are
	 * bracketed by SEPARATE Date.now() samples, so a handoff can read as a sub-millisecond overlap
	 * (measured: 1 ms between Transmission and Destination import on a real 28.5 s transfer); a span
	 * fully contained in an earlier one is collapsed and counted whole. Publishing the amount keeps
	 * it honest — a large value means the MODEL is wrong, not the clock, and the tests assert it
	 * stays negligible on real transfers.
	 */
	overlapTrimmedMs: number;
	/**
	 * Measured ms inside a measured window (the destination import, the export envelope) that its
	 * tick-derived breakdown does not reach. This is the understatement itself, as a number: the
	 * window is real elapsed time, the spans inside it count ticks, and a tick that runs long moves
	 * the former and not the latter. Only windows that HAVE a breakdown contribute — a window with
	 * no tick spans at all is simply an unbroken measured bar, not a gap.
	 */
	detailGapMs: number;
	/** detailGapMs as a share of the windows it was measured against — 0 when there are none. */
	detailGapPct: number;
};

export type TransferTimeline = {
	totalMs: number;
	rows: TimelineRow[];
	attribution: TimelineAttribution;
};

// ---------------------------------------------------------------------------------------------
// Presentation constants — exported so the browser tab and the offline preview render from the
// SAME tables instead of hand-mirrored copies (the mirrored copies drifted inside one PR).
// ---------------------------------------------------------------------------------------------

/** One palette for every color key the builder emits. Unknown keys fall back to `blue`. */
export const TIMELINE_PALETTE: Record<string, string> = {
	red: "#ff4d4f", green: "#52c41a", blue: "#1890ff",
	// Import waterfall — blue/cyan→indigo in pipeline order so the cascade reads segment-by-segment.
	tiles: "#36cfc9", entities: "#1890ff", belts: "#40a9ff", state: "#597ef7",
	inventories: "#2f54eb", validation: "#85a5ff", fluids: "#08979c",
	transmission: "#13c2c2", cleanup: "#73d13d",
	delivery: "#1d39c4", queue: "#adc6ff",
	// destImport: the measured wall-clock wait on the destination. residual: unattributed wall
	// clock (amber). detailGap: measured-but-unbroken time (dark orange) — a different statement
	// than residual, so a different color.
	destImport: "#0958d9", residual: "#faad14", detailGap: "#d46b08",
	exportQueue: "#91caff", exportAsync: "#69c0ff", exportStore: "#4096ff",
};

/** The hatch that marks a bar as tick-derived — never mistakable for elapsed time at a glance. */
export function tickHatch(color: string): string {
	return `repeating-linear-gradient(135deg, ${color} 0 4px, transparent 4px 8px)`;
}

export type GanttGeometry = { startPct: number; widthPct: number; markerPct: number };

/** Bar geometry both renderers use: zero-width spans stay invisible; real spans get a 0.8% floor. */
export function toGanttGeometry(row: { startMs: number; endMs: number }, totalMs: number): GanttGeometry {
	const scale = totalMs > 0 ? totalMs : 1;
	const startPct = Math.max(0, Math.min(100, (row.startMs / scale) * 100));
	return {
		startPct,
		widthPct: row.endMs > row.startMs
			? Math.max(0.8, Math.min(100 - startPct, ((row.endMs - row.startMs) / scale) * 100))
			: 0,
		markerPct: Math.max(0, Math.min(100, (row.endMs / scale) * 100)),
	};
}

/** Anything above this share is worth saying out loud rather than leaving to be noticed. */
const NOTICE_THRESHOLD_PCT = 5;

/**
 * A detail gap must ALSO clear this before it is worth a warning. Share alone cries wolf: on a
 * same-tick import one tick IS the resolution floor, so the breakdown is structurally unable to fill
 * the window and the percentage is meaningless. Measured on real transfers here — 2 KB: 6 ms gap
 * (86%), 87 KB: 388 ms (70%), 120 KB: 21.6 s (98%). A one-second floor names the last and stays
 * quiet on the first two, which are healthy sub-second transfers.
 */
const DETAIL_GAP_FLOOR_MS = 1000;

import { formatMs } from "./utils";

/**
 * The one wording for "this chart cannot account for its own time", so the browser tab and the
 * offline preview cannot drift into describing the same numbers differently.
 * Returns null when the timeline accounts for itself. When both findings fire, the headline
 * carries the unattributed time (the more serious statement) and the detail carries both.
 */
export function describeAttribution(attribution: TimelineAttribution): { headline: string; detail: string } | null {
	const notices: Array<{ headline: string; detail: string }> = [];
	if (attribution.residualPct > NOTICE_THRESHOLD_PCT) {
		notices.push({
			headline: `${formatMs(attribution.residualMs)} of ${formatMs(attribution.totalMs)} `
				+ `(${attribution.residualPct.toFixed(0)}%) is unattributed`,
			detail: "No measured span covers this time. It is bounded by the spans on either side of it.",
		});
	}
	if (attribution.detailGapPct > NOTICE_THRESHOLD_PCT && attribution.detailGapMs >= DETAIL_GAP_FLOOR_MS) {
		notices.push({
			headline: `${formatMs(attribution.detailGapMs)} of measured work `
				+ `(${attribution.detailGapPct.toFixed(0)}%) has no phase detail`,
			detail: "The window is measured wall clock, but the spans inside it are game.tick deltas "
				+ "scaled by a nominal 60 UPS. A tick that runs long does not widen them, so the "
				+ "breakdown stops short of the window it sits in. The dark-orange bar is the difference, not idle time.",
		});
	}
	if (notices.length === 0) return null;
	return {
		headline: notices[0].headline,
		detail: notices.map(notice => notices.length > 1 ? `${notice.headline}: ${notice.detail}` : notice.detail).join(" "),
	};
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

/** A measured window whose tick-derived children owe it a breakdown. */
type DetailWindow = { startMs: number; endMs: number; children: TimelineRow[] };

/**
 * Assemble the transfer timeline. Pure: no clock, no DOM, no I/O — so `npm test` can pin its
 * invariants against real recorded transfers.
 */
export function buildTransferTimeline(
	events: readonly TimelineEventInput[] | null | undefined,
	detailedSummary: Record<string, unknown> | null,
): TransferTimeline {
	const rows: TimelineRow[] = [];
	// Measured windows and the tick-derived rows nested inside them, tracked EXPLICITLY at push
	// time. Selecting children later by indent once clamped the export's async bar into the import
	// window; selecting the window by colour would break on a second validationMs-carrying event
	// (a late or redelivered verdict) — the FIRST window is the one the phases belong to.
	const detailWindows: DetailWindow[] = [];
	let importWindow: DetailWindow | null = null;
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
			key: `event:${type}:${at}`, label: type, indent: 0,
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
					key: `export:lock:${at}`, label: "Request export + lock source", indent: 1,
					startMs: lockStart, endMs: lockEnd, durationMs: lockMs, color: "exportQueue", kind: "measured",
					note: "Controller wall clock: export request through source lock.",
				});
			}
			if (storeMs > 0) {
				rows.push({
					key: `export:store:${at}`, label: "Wait for store", indent: 1,
					startMs: lockEnd, endMs: at, durationMs: storeMs, color: "exportStore", kind: "measured",
					note: "Controller wall clock: waiting for the export to land in the controller store.",
				});
			}
			// Tick-derived: math.floor(duration_ticks * 16.67) from export-pipeline.lua. Structurally
			// blind to a tick stall — it cannot grow when the game slows down. The async export runs
			// somewhere inside the WHOLE lock+store envelope (the export request returns at export_id
			// creation; the store wait is where the async span actually elapses), so its bar anchors
			// at the envelope start and the envelope — not the lock span alone — is the measured
			// parent its detail gap is judged against.
			const asyncMs = positive(exportMetrics.instanceAsyncExportMs);
			const ticks = positive(exportMetrics.instanceAsyncExportTicks);
			const envelopeStart = lockMs > 0 || storeMs > 0 ? lockStart : at;
			if (asyncMs !== null) {
				const asyncRow: TimelineRow = {
					key: `export:async:${at}`, label: ticks !== null
						? `Async export (${ticks.toLocaleString()} ticks)` : "Async export",
					indent: lockMs > 0 || storeMs > 0 ? 2 : 1,
					startMs: Math.max(0, envelopeStart === at ? at - asyncMs : envelopeStart),
					endMs: envelopeStart === at ? at : Math.min(envelopeStart + asyncMs, at),
					durationMs: asyncMs, color: "exportAsync", kind: "tickDerived",
					note: `${ticks ?? "?"} ticks x 16.67 ms nominal — a tick count, not elapsed time.`,
				};
				rows.push(asyncRow);
				if (lockMs > 0 || storeMs > 0) {
					detailWindows.push({ startMs: lockStart, endMs: at, children: [asyncRow] });
				}
			}
		}

		// ---- Transmission: controller -> destination, INCLUDING the destination's RCON chunk feed. ----
		// The destination awaits its whole chunk feed inside this request, so the payload upload is
		// already inside this measured span. (Measured: 114-346 ms for a 120 KB payload — the upload
		// is not the dominant cost this chart was once thought to be hiding.)
		const transmissionMs = positive(event.transmissionMs);
		if (transmissionMs !== null) {
			rows.push({
				key: `phase:transmission:${at}`, label: "Transmission + payload upload", indent: 1,
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
				key: `phase:destimport:${at}`, label: "Destination import", indent: 1,
				startMs: start, endMs: at, durationMs: validationMs, color: "destImport", kind: "measured",
				note: "Controller wall clock: destination accepted the import until its verdict arrived.",
			});
			if (!importWindow) {
				importWindow = { startMs: start, endMs: at, children: [] };
				detailWindows.push(importWindow);
			}
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
				for (const span of [...spans].sort((a, b) => (finite(a.startOffsetMs) ?? 0) - (finite(b.startOffsetMs) ?? 0))) {
					const name = String(span.name || "phase");
					const startMs = segStart + (finite(span.startOffsetMs) ?? 0);
					const dur = finite(span.durationMs) ?? 0;
					const count = positive(counts[name]);
					const base = IMPORT_SPAN_LABELS[name] || humanize(name);
					const row: TimelineRow = {
						key: `import:${name}:${at}`, label: count !== null ? `${base} (${count.toLocaleString()})` : base,
						indent: 2,
						// Floor to 1 ms so a sub-tick phase stays visible as a sliver rather than vanishing.
						// Tick spans NEVER extend totalMs — a tick count must not manufacture axis time.
						startMs, endMs: startMs + Math.max(dur, 1), durationMs: dur || null,
						color: name, kind: "tickDerived",
						note: dur === 0
							? "Under one tick — below what game.tick can resolve, not instant."
							: "Tick count x 16.67 ms nominal — not elapsed time.",
					};
					rows.push(row);
					if (importWindow) importWindow.children.push(row);
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
					key: `phase:${key}:${at}`, label: humanize(name), indent: 1,
					startMs: at - ms, endMs: at, durationMs: ms, color: name, kind: "measured",
					note: "Controller wall clock.",
				});
			}
		}
	}

	// ---- Attribution: every measured ms belongs to a named span, or to an explicit residual. ----
	// Tile the measured spans. The rows themselves are the ones drawn, so trim THEM and derive the
	// intervals from the trimmed rows — otherwise attribution and the picture could disagree. A
	// straddling span is trimmed to start at the prior end; a fully CONTAINED span is collapsed
	// (its whole width counted as trimmed) — both keep the honesty metric complete.
	let overlapTrimmedMs = 0;
	const measuredRows = rows.filter(row => row.kind === "measured").sort((a, b) => a.startMs - b.startMs);
	let priorEnd = 0;
	for (const row of measuredRows) {
		if (row.endMs <= priorEnd && row.startMs < priorEnd) {
			// Fully contained: collapse to a zero-width row parked at the prior end (not at its own
			// end, which would leave a marker stranded inside the containing bar).
			overlapTrimmedMs += row.endMs - row.startMs;
			row.startMs = priorEnd;
			row.endMs = priorEnd;
			row.durationMs = 0;
		} else if (row.startMs < priorEnd && row.endMs > priorEnd) {
			overlapTrimmedMs += priorEnd - row.startMs;
			row.startMs = priorEnd;
			row.durationMs = row.endMs - row.startMs;
		}
		priorEnd = Math.max(priorEnd, row.endMs);
	}

	// Disjoint and sorted after the trim; clamping to [0, totalMs] preserves both.
	const covered = measuredRows
		.map(row => [Math.max(0, row.startMs), Math.min(row.endMs, totalMs)] as [number, number])
		.filter(([a, b]) => b > a);
	for (const [start, end] of gapsWithin(covered, totalMs)) {
		rows.push({
			key: `residual:${start}`, label: "Unattributed", indent: 1,
			startMs: start, endMs: end, durationMs: end - start, color: "residual", kind: "residual",
			note: "Wall-clock time no measured span covers. Bounded by the spans on either side.",
		});
	}

	// ---- Detail gaps: each measured window minus what its tick-derived children reach. ----
	// Without this the chart looks fully attributed — a 22 s measured bar with 0.5 s of hatched
	// spans at its left edge and no statement anywhere that the other 21.5 s has no breakdown.
	// A window with NO children contributes nothing: an unbroken measured bar already says,
	// honestly, that nothing reported a breakdown — fabricating a "phases stopped short" row there
	// mislabeled every validation-timeout wait.
	let detailGapMs = 0;
	let windowTotalMs = 0;
	for (const window of detailWindows) {
		if (window.children.length === 0) continue;
		// A tick offset can land PAST the measured window it describes (a 7 ms import whose later
		// phases claim a 16 ms — one tick — offset). Drawing it outside its own parent would say
		// the work continued after the window closed, so clamp; the width was never elapsed time,
		// but the containment is real.
		for (const row of window.children) {
			row.startMs = Math.min(Math.max(row.startMs, window.startMs), window.endMs);
			row.endMs = Math.min(Math.max(row.endMs, row.startMs), window.endMs);
			row.durationMs = row.durationMs === null ? null : Math.min(row.durationMs, row.endMs - row.startMs);
		}
		const windowMs = window.endMs - window.startMs;
		windowTotalMs += windowMs;
		for (const [start, end] of gapsWithin(
			window.children.map(row => [row.startMs - window.startMs, row.endMs - window.startMs] as [number, number]),
			windowMs,
		)) {
			detailGapMs += end - start;
			rows.push({
				key: `detailgap:${window.startMs}:${start}`, label: "No phase detail", indent: 2,
				startMs: window.startMs + start, endMs: window.startMs + end,
				durationMs: end - start, color: "detailGap", kind: "detailGap",
				note: "Inside a measured window, but past where its tick-derived spans reach. "
					+ "Span marks are game.tick deltas; a tick that runs long does not widen them.",
			});
		}
	}
	const detailGapPct = windowTotalMs > 0 ? (detailGapMs / windowTotalMs) * 100 : 0;

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
