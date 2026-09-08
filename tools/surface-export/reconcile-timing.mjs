#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { readTransactionLogStore } from "../tests/testkit/log-query.mjs";
import { docker, HOSTS, instancePath } from "../../tests/lab-gallery/batch-lifecycle.mjs";
const require = createRequire(import.meta.url);
const { parseLuaTiming } = require("../../docker/seed-data/external_plugins/surface_export/dist/node/lib/timing.js");
const prefix = process.argv[2] || "hub-req-sections-";
const entries = readTransactionLogStore().filter(entry => entry.transferInfo?.platformName?.startsWith(prefix));
assert.ok(entries.length, "No matching retained operations");
const logs = [1, 2].map(host => docker(["exec", HOSTS[host].container, "cat", instancePath(host, "factorio-current.log")]));
const report = [];
for (const entry of entries.slice(-2)) {
	const records = entry.summary?.timing?.records;
	assert.ok(records?.length, `Missing timing for ${entry.transferId}`);
	const root = records.find(row => row.stage === "Observed operation");
	assert.ok(root && root.endMs !== null);
	assert.ok(Math.abs(root.endMs - root.startMs - entry.summary.totalDurationMs) < 1e-6);
	let rawCount = 0;
	for (const row of records.filter(row => row.raw)) {
		assert.ok(logs.some(log => log.includes(row.raw)), `No actual Factorio output for ${row.clockId}/${row.id}`);
		const parsed = parseLuaTiming(row.raw, row.instanceId, "reconciliation");
		assert.ok(parsed && !parsed.error, row.raw);
		for (const key of ["startMs", "endMs", "executionMs", "startTick", "endTick", "ticksElapsed", "batchCount", "workTicks", "status"])
			assert.equal(row[key], parsed[key], `${entry.transferId}/${row.stage}/${key}`);
		if (row.startTick !== undefined && row.endTick !== undefined) assert.equal(row.ticksElapsed, row.endTick - row.startTick);
		rawCount++;
	}
	assert.ok(rawCount >= 20, "Expected full source and destination phase evidence");
	const owners = [...new Set(records.map(row => row.owner))];
	assert.ok(owners.includes("source-lua") && owners.includes("destination-lua") && owners.includes("controller"));
	report.push({ operation: entry.transferId, outcome: entry.transferInfo.status, records: records.length, rawReadingsVerified: rawCount,
		observedDurationMs: entry.summary.totalDurationMs, owners, failedStages: records.filter(row => row.status === "failed").map(row => row.stage) });
}
mkdirSync("ci-artifacts/timing", { recursive: true });
writeFileSync("ci-artifacts/timing/reconciliation.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
