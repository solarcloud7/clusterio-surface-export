#!/usr/bin/env node
// Distil real recorded transfers into the timing-only fixture set the timeline tests pin against
// (test/fixtures/real-transfer-timelines.json). Only the fields the timeline reads survive — no
// validation maps, no payloads — so the fixtures stay small and diff-reviewable.
//
//   docker cp surface-export-controller:/clusterio/data/database/surface_export_transaction_logs.json .
//   node tools/surface-export/make-timeline-fixtures.mjs surface_export_transaction_logs.json
//
// Selection is by SHAPE, not by name alone: the five labels each pin a distinct timeline class
// (workhorse with phase spans, mid-size, sub-tick, failed rollback, transmission outlier). If a
// label's predicate stops matching anything in the log, this tool FAILS rather than silently
// writing a smaller fixture set — replace the predicate deliberately, with a transfer of the same
// class.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE,
	"../../docker/seed-data/external_plugins/surface_export/test/fixtures/real-transfer-timelines.json");

const logPath = process.argv[2];
if (!logPath) {
	console.error("Usage: node tools/surface-export/make-timeline-fixtures.mjs <surface_export_transaction_logs.json> [--out <path>]");
	process.exit(2);
}
const outPath = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : OUT;

const raw = JSON.parse(readFileSync(logPath, "utf8"));
const entries = Array.isArray(raw) ? raw : (raw.transactionLogs || []);

const keepEvent = ev => {
	const out = { eventType: ev.eventType, elapsedMs: ev.elapsedMs };
	if (typeof ev.transmissionMs === "number") out.transmissionMs = ev.transmissionMs;
	if (typeof ev.validationMs === "number") out.validationMs = ev.validationMs;
	if (ev.phases) out.phases = ev.phases;
	if (ev.exportMetrics) {
		const m = ev.exportMetrics;
		out.exportMetrics = {};
		for (const k of ["requestExportAndLockMs", "waitForControllerStoreMs", "instanceAsyncExportMs",
			"instanceAsyncExportTicks", "controllerExportPrepTotalMs"]) {
			if (typeof m[k] === "number") out.exportMetrics[k] = m[k];
		}
	}
	if (ev.importMetrics) {
		const m = ev.importMetrics;
		out.importMetrics = { total_ms: m.total_ms, total_ticks: m.total_ticks };
		for (const k of ["tiles_placed", "entities_created", "fluids_restored", "belt_items_restored", "circuits_connected"]) {
			if (typeof m[k] === "number") out.importMetrics[k] = m[k];
		}
		if (Array.isArray(m.phaseSpans)) {
			out.importMetrics.phaseSpans = m.phaseSpans.map(s => ({
				name: s.name, startOffsetMs: s.startOffsetMs, durationMs: s.durationMs,
			}));
		}
	}
	return out;
};

const pick = (label, predicate) => {
	const e = entries.filter(predicate).pop();
	if (!e) {
		console.error(`FAIL: no entry in ${logPath} matches fixture class '${label}' — `
			+ "replace its predicate with a transfer of the same class rather than dropping the fixture.");
		process.exit(1);
	}
	return {
		label,
		transferId: e.transferId,
		platformName: e.transferInfo?.platformName,
		artifactSizeBytes: e.transferInfo?.artifactSizeBytes ?? null,
		events: (e.events || []).map(keepEvent),
	};
};

const has = (e, t) => (e.events || []).some(v => v.eventType === t);
const spans = e => (e.events || []).some(v => Array.isArray(v.importMetrics?.phaseSpans) && v.importMetrics.phaseSpans.length);
const kb = e => (e.transferInfo?.artifactSizeBytes ?? 0) / 1024;
const wall = e => {
	const evs = e.events || [];
	const t0 = evs[0]?.timestampMs ?? evs[0]?.elapsedMs ?? 0;
	return Math.max(...evs.map(v => (v.timestampMs ?? v.elapsedMs ?? t0) - t0), 0);
};

const fixtures = [
	// The workhorse class: large payload, full phase spans, multi-second import window.
	pick("workhorse-120kb", e => kb(e) > 100 && has(e, "transfer_completed") && spans(e) && wall(e) > 5000),
	// Mid-size with a different phase shape.
	pick("omnibus-87kb", e => kb(e) > 50 && kb(e) <= 100 && has(e, "transfer_completed") && spans(e)),
	// Sub-second transfer: every span at or below tick resolution.
	pick("tiny-2kb", e => kb(e) < 4 && has(e, "transfer_completed") && spans(e)),
	// A FAILED transfer: rollback path, validation timeout, no import breakdown.
	pick("failed-timeout", e => has(e, "transfer_failed") && has(e, "validation_timeout")),
	// Transmission outlier: upload wall far above the sibling norm for its size.
	pick("slow-transmission", e => has(e, "transfer_completed")
		&& (e.events || []).some(v => typeof v.transmissionMs === "number" && v.transmissionMs > 5000)),
];

writeFileSync(outPath, `${JSON.stringify(fixtures, null, "\t")}\n`);
console.log(`Wrote ${fixtures.length} fixtures -> ${outPath}`);
for (const f of fixtures) {
	console.log(`  ${f.label.padEnd(20)} ${String(f.platformName).slice(0, 26).padEnd(28)} events=${f.events.length}`);
}
