#!/usr/bin/env node
// Offline analysis: never starts transfers or changes the running cluster.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { parseLuaTiming } = require("../../docker/seed-data/external_plugins/surface_export/dist/node/lib/timing.js");

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("Usage: node tools/surface-export/analyze-work-budgets.mjs <transaction-log-store.json> <report.json>");
const entries = JSON.parse(readFileSync(input, "utf8"));
if (!Array.isArray(entries)) throw new Error("Expected the transaction-log store array");
const groups = { singleIntervals: new Map(), accumulatedStages: new Map(), debugBatches: new Map() };
const unavailable = [];
let validReadings = 0;
for (const entry of entries) {
	const unique = new Map();
	for (const record of entry.summary?.timing?.records || []) {
		if (!["source-lua", "destination-lua", "recovery-lua"].includes(record.owner)) continue;
		const key = JSON.stringify([record.clockId, record.id]);
		if (!unique.has(key) || (record.revision || 0) > (unique.get(key).revision || 0)) unique.set(key, record);
	}
	for (const record of unique.values()) {
		if (record.kind !== "execution" || record.status === "skipped") continue;
		const problem = reasonUnavailable(record);
		if (problem) { unavailable.push({ operation: entry.transferId, clock: record.clockId, id: record.id, reason: problem }); continue; }
		validReadings++;
		const bucket = record.batch !== undefined ? "debugBatches" : record.batchCount === 1 ? "singleIntervals" : "accumulatedStages";
		const key = `${record.owner}/${record.stage}`;
		const aggregate = groups[bucket].get(key) || { stage: key, samples: 0, maximumExecutionMs: -1 };
		aggregate.samples++;
		if (record.executionMs > aggregate.maximumExecutionMs) {
			aggregate.maximumExecutionMs = record.executionMs;
			aggregate.witness = { operation: entry.transferId, platform: entry.transferInfo?.platformName,
				savedAt: entry.savedAt, clock: record.clockId, id: record.id, status: record.status,
				startMs: record.startMs, endMs: record.endMs, startTick: record.startTick, endTick: record.endTick,
				batchCount: record.batchCount, workTicks: record.workTicks, truncated: record.truncated === true,
				entities: entry.summary?.export?.exportedEntityCount, tiles: entry.summary?.export?.exportedTileCount,
				raw: record.raw };
		}
		groups[bucket].set(key, aggregate);
	}
}

function reasonUnavailable(record) {
	if (!["completed", "failed"].includes(record.status)) return `Stage status: ${record.status}`;
	if (!record.raw) return "No raw profiler reading";
	const parsed = parseLuaTiming(record.raw, record.instanceId, "offline-budget-audit");
	if (!parsed || parsed.error) return parsed?.error || "Raw profiler reading did not parse";
	for (const key of ["v", "id", "owner", "jobId", "stage", "kind", "startMs", "endMs", "executionMs", "batchCount", "startTick", "endTick", "workTicks", "status"]) {
		if (parsed[key] !== record[key]) return `Stored ${key} differs from raw reading`;
	}
	if (![record.startMs, record.endMs, record.executionMs].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)) return "Missing or invalid duration boundary";
	if (record.endMs < record.startMs || !Number.isInteger(record.batchCount) || record.batchCount < 1) return "Invalid interval or batch count";
	return null;
}

const report = {
	input, retainedOperations: entries.length, validReadings, unavailable,
	limitations: [
		"Historical retained sample across deployments and fixtures; not a benchmark of current code.",
		"Raw strings are reparsed and compared with stored fields; independent engine-log corroboration is a separate check.",
		"Single intervals measure one stage invocation, not the full game callback or exclusive CPU time.",
		"Accumulated stages sum work across batches. They do not establish the largest individual batch.",
		"Debug batch samples are optional, capped, and may overlap parent stages; never add these tables together.",
		"No conversion of ticks to milliseconds, no cross-clock alignment, and no inferred callback maximum.",
	],
	...Object.fromEntries(Object.entries(groups).map(([name, values]) => [name, [...values.values()].sort((a, b) => b.maximumExecutionMs - a.maximumExecutionMs)])),
};
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(`Read ${entries.length} retained operations; ${validReadings} verified readings, ${unavailable.length} unavailable.`);
for (const [name] of Object.entries(groups)) {
	console.log(`\n${name} (separate measurements; do not sum):`);
	for (const row of report[name].slice(0, 10)) console.log(`${row.maximumExecutionMs.toFixed(3)} ms  ${row.stage}  n=${row.samples}  ${row.witness.operation}`);
}
