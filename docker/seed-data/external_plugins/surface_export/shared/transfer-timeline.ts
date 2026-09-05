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
	note?: string;
};

export type TimelineAttribution = {
	totalMs: number;
	attributedMs: number;
	residualMs: number;
	residualPct: number;
	overlapTrimmedMs: number;
	detailGapMs: number;
	detailGapPct: number;
	sourceExportCallMs: number | null;
	sourceExportAsyncMs: number | null;
	sourceExportAsyncTicks: number | null;
	sourceExportAnchored: boolean;
	importWindowMs: number | null;
	importDetailGapMs: number;
};

export type TransferTimeline = {
	totalMs: number;
	rows: TimelineRow[];
	attribution: TimelineAttribution;
};


export const TIMELINE_PALETTE: Record<string, string> = {
	red: "#ff4d4f", green: "#52c41a", blue: "#1890ff",
	tiles: "#36cfc9", entities: "#1890ff", belts: "#40a9ff", state: "#597ef7",
	inventories: "#2f54eb", validation: "#85a5ff", fluids: "#08979c",
	transmission: "#13c2c2", cleanup: "#73d13d",
	delivery: "#1d39c4", queue: "#adc6ff",
	destImport: "#0958d9", residual: "#faad14", detailGap: "#8c8c8c",
	exportQueue: "#91caff", exportAsync: "#69c0ff", exportStore: "#4096ff",
};

export function tickHatch(color: string): string {
	return `repeating-linear-gradient(135deg, ${color} 0 4px, transparent 4px 8px)`;
}

export type GanttGeometry = { startPct: number; widthPct: number; markerPct: number };

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

const NOTICE_THRESHOLD_PCT = 5;

import { formatMs } from "./utils";

export function describeAttribution(attribution: TimelineAttribution): { headline: string; detail: string } | null {
	const notices: Array<{ headline: string; detail: string }> = [];
	if (attribution.residualPct > NOTICE_THRESHOLD_PCT) {
		notices.push({
			headline: `${formatMs(attribution.residualMs)} of ${formatMs(attribution.totalMs)} `
				+ `(${attribution.residualPct.toFixed(0)}%) is unattributed`,
			detail: "No measured span covers this time. It is bounded by the spans on either side of it.",
		});
	}
	if (notices.length === 0) return null;
	return {
		headline: notices[0].headline,
		detail: notices.map(notice => notices.length > 1 ? `${notice.headline}: ${notice.detail}` : notice.detail).join(" "),
	};
}

export const SOURCE_EXPORT_ANOMALY_MS = 5000;
export const IMPORT_GAP_ANOMALY_MS = 5000;

export function describeImportGapAnomaly(attribution: TimelineAttribution): { headline: string; detail: string } | null {
	if (attribution.importWindowMs === null || attribution.importDetailGapMs < IMPORT_GAP_ANOMALY_MS) return null;
	const attributed = Math.max(0, attribution.importWindowMs - attribution.importDetailGapMs);
	return {
		headline: `Destination import ran ${formatMs(attribution.importWindowMs)} of wall clock with only `
			+ `${formatMs(attributed)} tick-attributed`,
		detail: `The import phases are game.tick spans at a nominal 60 UPS; ${formatMs(attribution.importDetailGapMs)} `
			+ "of the measured window is synchronous work inside ticks, or time below one tick of resolution. "
			+ "Not idle time and not a missing measurement.",
	};
}

export function describeSourceExportAnomaly(attribution: TimelineAttribution): { headline: string; detail: string } | null {
	const callMs = attribution.sourceExportCallMs;
	if (callMs === null || callMs < SOURCE_EXPORT_ANOMALY_MS) return null;
	const asyncPart = attribution.sourceExportAsyncMs !== null
		? ` The tick-measured async export that follows it took ${formatMs(attribution.sourceExportAsyncMs)}`
			+ `${attribution.sourceExportAsyncTicks !== null ? ` (${attribution.sourceExportAsyncTicks.toLocaleString()} ticks)` : ""}.`
		: "";
	return {
		headline: `Source instance spent ${formatMs(callMs)} inside one synchronous export call`,
		detail: `The export request to the source returned after ${formatMs(callMs)} of controller wall clock. `
			+ "That call locks the platform and scans it before the async export is queued, so no game tick "
			+ `can attribute time inside it — the bar is the measurement, not a rendering gap.${asyncPart}`
			+ (attribution.sourceExportAnchored
				? " Anchored on the export_requested / export_returned events."
				: " Back-computed from requestExportAndLockMs; this log predates the anchor events."),
	};
}

const RESIDUAL_FLOOR_MS = 2;

function finite(value: unknown): number | null {
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

function positive(value: unknown): number | null {
	const n = finite(value);
	return n !== null && n > 0 ? n : null;
}

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
	validation: "Validation gate",
};

function humanize(key: string) {
	return String(key)
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.replace(/^./, c => c.toUpperCase());
}

type DetailWindow = { startMs: number; endMs: number; children: TimelineRow[] };

export function buildTransferTimeline(
	events: readonly TimelineEventInput[] | null | undefined,
	detailedSummary: Record<string, unknown> | null,
): TransferTimeline {
	const rows: TimelineRow[] = [];
	const detailWindows: DetailWindow[] = [];
	let importWindow: DetailWindow | null = null;
	const list = (events || []).filter(Boolean);
	let totalMs = 0;
	let sourceExportCallMs: number | null = null;
	let sourceExportAsyncMs: number | null = null;
	let sourceExportAsyncTicks: number | null = null;
	let sourceExportAnchored = false;

	const eventAt: Record<string, number> = {};
	for (const ev of list) {
		const at = finite(ev.elapsedMs);
		if (at !== null && ev.eventType) eventAt[String(ev.eventType)] = at;
	}

	for (const event of list) {
		const at = finite(event.elapsedMs) ?? 0;
		const type = String(event.eventType || "event");
		totalMs = Math.max(totalMs, at);
		if (type === "export_requested" || type === "export_returned") continue;
		const isFailure = /failed|error|timeout/.test(type);
		const isSuccess = /completed|success/.test(type);

		rows.push({
			key: `event:${type}:${at}`, label: type, indent: 0,
			startMs: at, endMs: at, durationMs: null,
			color: isFailure ? "red" : isSuccess ? "green" : "blue", kind: "event",
		});

		const exportMetrics = (event.exportMetrics
			|| (type === "transfer_created" ? (detailedSummary?.export as Record<string, unknown>) : null)) as
			Record<string, unknown> | null;
		if (exportMetrics) {
			const lockMsMetric = finite(exportMetrics.requestExportAndLockMs) ?? 0;
			const storeMsMetric = finite(exportMetrics.waitForControllerStoreMs) ?? 0;
			const requestedAt = finite(eventAt["export_requested"]);
			const returnedAt = finite(eventAt["export_returned"]);
			const anchored = requestedAt !== null && returnedAt !== null
				&& requestedAt <= returnedAt && returnedAt <= at;
			const callEnd = anchored ? returnedAt : at - storeMsMetric;
			const callStart = anchored ? requestedAt : callEnd - lockMsMetric;
			const callMs = callEnd - callStart;
			const storeMs = at - callEnd;
			const hasEnvelope = callMs > 0 || storeMs > 0;
			if (callMs > 0) {
				rows.push({
					key: `export:call:${at}`, label: "Source export call", indent: 1,
					startMs: callStart, endMs: callEnd, durationMs: callMs, color: "exportQueue", kind: "measured",
					note: anchored
						? "Controller wall clock: export request sent to the source until it returned. Anchored on export_requested / export_returned."
						: "Controller wall clock: export request sent to the source until it returned. Back-computed from requestExportAndLockMs (no anchor events in this log).",
				});
				sourceExportCallMs = callMs;
				sourceExportAnchored = anchored;
			}
			if (storeMs > 0) {
				rows.push({
					key: `export:store:${at}`, label: "Wait for store", indent: 1,
					startMs: callEnd, endMs: at, durationMs: storeMs, color: "exportStore", kind: "measured",
					note: "Controller wall clock: the async export runs on the source, then lands in the controller store.",
				});
			}
			const asyncMs = positive(exportMetrics.instanceAsyncExportMs);
			const ticks = positive(exportMetrics.instanceAsyncExportTicks);
			if (asyncMs !== null) {
				const asyncStart = hasEnvelope ? callEnd : Math.max(0, at - asyncMs);
				const asyncRow: TimelineRow = {
					key: `export:async:${at}`, label: ticks !== null
						? `Async export (${ticks.toLocaleString()} ticks)` : "Async export",
					indent: hasEnvelope ? 2 : 1,
					startMs: asyncStart,
					endMs: Math.min(asyncStart + asyncMs, at),
					durationMs: asyncMs, color: "exportAsync", kind: "tickDerived",
					note: `${ticks ?? "?"} ticks x 16.67 ms nominal — a tick count, not elapsed time.`,
				};
				rows.push(asyncRow);
				sourceExportAsyncMs = asyncMs;
				sourceExportAsyncTicks = ticks;
				if (hasEnvelope) {
					detailWindows.push({ startMs: callStart, endMs: at, children: [asyncRow] });
				}
			}
		}

		const transmissionMs = positive(event.transmissionMs);
		if (transmissionMs !== null) {
			rows.push({
				key: `phase:transmission:${at}`, label: "Transmission + payload upload", indent: 1,
				startMs: at - transmissionMs, endMs: at, durationMs: transmissionMs,
				color: "transmission", kind: "measured",
				note: "Controller wall clock: import request sent until the destination accepted it (its RCON chunk feed runs inside).",
			});
		}

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

		if (event.phases && typeof event.phases === "object") {
			for (const [key, value] of Object.entries(event.phases as Record<string, unknown>)) {
				if (key === "transmissionMs" || key === "validationMs") continue;
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

	let overlapTrimmedMs = 0;
	const measuredRows = rows.filter(row => row.kind === "measured").sort((a, b) => a.startMs - b.startMs);
	let priorEnd = 0;
	for (const row of measuredRows) {
		if (row.endMs <= priorEnd && row.startMs < priorEnd) {
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

	let detailGapMs = 0;
	let importDetailGapMs = 0;
	let windowTotalMs = 0;
	for (const window of detailWindows) {
		if (window.children.length === 0) continue;
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
			if (window === importWindow) importDetailGapMs += end - start;
			rows.push({
				key: `detailgap:${window.startMs}:${start}`, label: "Not tick-attributed", indent: 2,
				startMs: window.startMs + start, endMs: window.startMs + end,
				durationMs: end - start, color: "detailGap", kind: "detailGap",
				note: "Measured wall clock inside this window that no game.tick span covers: synchronous work, "
					+ "or time below one tick (16.67 ms) of resolution. Not idle, not a missing measurement.",
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
			sourceExportCallMs,
			sourceExportAsyncMs,
			sourceExportAsyncTicks,
			sourceExportAnchored,
			importWindowMs: importWindow ? (importWindow as DetailWindow).endMs - (importWindow as DetailWindow).startMs : null,
			importDetailGapMs,
		},
	};
}
