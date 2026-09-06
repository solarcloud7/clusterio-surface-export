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
	if (typeof value !== "number") return null;
	const n = value;
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

export function buildTransferTimeline(events: readonly TimelineEventInput[] | null | undefined,
 detailedSummary: Record<string, unknown> | null): TransferTimeline {
 const rows: TimelineRow[] = [];
 let totalMs = positive(detailedSummary?.totalDurationMs) ?? 0;
 const list = (events ?? []).filter(event => event.eventType !== "timing_updated");
 const eventAt = new Map(list.map(event => [event.eventType, finite(event.elapsedMs)]));
 const add = (key: string, label: string, start: number | null, end: number | null, color: string) => {
  if (start === null || end === null || start < 0 || end < start) return;
  rows.push({ key, label, startMs: start, endMs: end, durationMs: end - start,
   color, indent: 1, kind: "measured", note: "Legacy controller elapsed time; includes remote handling and waits." });
  totalMs = Math.max(totalMs, end);
 };
 for (const [index, event] of list.entries()) {
  const at = finite(event.elapsedMs);
  if (at === null || at < 0) continue;
  totalMs = Math.max(totalMs, at);
  rows.push({ key: `event:${index}`, label: String(event.eventType ?? "event"), startMs: at, endMs: at,
   durationMs: null, kind: "event", color: "blue", indent: 0 });
  const spans = [["transmissionMs", "Import request round trip", "transmission"],
   ["validationMs", "Await destination completion", "destImport"]];
  for (const [field, label, color] of spans) {
   const duration = finite(event[field]);
   if (duration !== null) add(`${field}:${index}`, label, at - duration, at, color);
  }
  if (event.eventType === "export_returned") add(`export:${index}`, "Export request round trip",
   eventAt.get("export_requested") ?? null, at, "blue");
  for (const [name, value] of Object.entries(event.phases ?? {})) {
   if (!["cleanupMs", "rollbackMs"].includes(name)) continue;
   const duration = finite(value);
   if (duration !== null) add(`${name}:${index}`, name === "cleanupMs" ? "Source cleanup round trip" : "Rollback round trip",
    at - duration, at, "green");
  }
 }
 const covered = rows.filter(row => row.kind === "measured").map(row => [row.startMs, row.endMs] as [number, number]);
 const attributedMs = mergeIntervals(covered).reduce((sum, [a,b]) => sum + b - a, 0);
 const residualMs = Math.max(0, totalMs - attributedMs);
 return { rows: rows.sort((a,b) => a.startMs - b.startMs), totalMs, attribution: {
  totalMs, attributedMs, residualMs, residualPct: totalMs ? residualMs / totalMs * 100 : 0,
  overlapTrimmedMs: 0, detailGapMs: 0, detailGapPct: 0, sourceExportCallMs: null,
  sourceExportAsyncMs: null, sourceExportAsyncTicks: null, sourceExportAnchored: false,
  importWindowMs: null, importDetailGapMs: 0,
 } };
}
