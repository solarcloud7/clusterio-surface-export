#!/usr/bin/env node
// Bounded, world-state-free profiler checks on the running Factorio 2.1.17 instance.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { lua, docker, HOSTS, instancePath, sleep } from "../../tests/lab-gallery/batch-lifecycle.mjs";

const require = createRequire(import.meta.url);
const { parseLuaTiming, parseProfiler } = require("../../docker/seed-data/external_plugins/surface_export/dist/node/lib/timing.js");
const run = `timing-probe-${Date.now()}`;
function checked(body) {
	const result = lua(1, body);
	assert.equal(result.success, true, JSON.stringify(result));
	return result;
}
const before = checked('return {success=true,version=remote.call("surface_export","get_module_version"),factorio=script.active_mods.base,debug=storage.surface_export_config.profile_batches==true}');
assert.equal(before.factorio, "2.1.17", "This evidence is pinned to Factorio 2.1.17");
const probe = (action, id) => checked(`return remote.call("surface_export","timing_selftest","${action}","${id}")`);
probe("start", `${run}-wait`);
await sleep(120);
probe("finish", `${run}-wait`);
for (let repeat = 0; repeat < 5; repeat++) {
	for (const mode of ["baseline", "normal", "debug"]) probe(mode, `${run}-${mode}-${repeat}`);
}
probe("cap", `${run}-cap`);
await sleep(500);
const lines = docker(["exec", HOSTS[1].container, "cat", instancePath(1, "factorio-current.log")]).split(/\r?\n/).filter(line => line.includes(run));
const parsed = lines.filter(line => line.includes("[SE_TIMING_V1]")).map(line => parseLuaTiming(line, 1, "probe-runtime"));
assert.ok(parsed.length > 2000); assert.ok(parsed.every(Boolean)); assert.ok(parsed.every(row => !row.error));
const phase = id => parsed.find(row => row.jobId === id && row.id === "entities" && row.status === "completed");
const wait = phase(`${run}-wait`);
assert.equal(wait.batchCount, 2); assert.equal(wait.workTicks, 2); assert.ok(wait.ticksElapsed > 0);
assert.ok(wait.executionMs > 0 && wait.endMs - wait.startMs > wait.executionMs + 100);
const sameTick = phase(`${run}-normal-0`);
assert.equal(sameTick.ticksElapsed, 0); assert.ok(sameTick.executionMs > 0); assert.equal(sameTick.batchCount, 100); assert.equal(sameTick.workTicks, 1);
const capped = phase(`${run}-cap`);
assert.equal(capped.batchCount, 2005); assert.equal(capped.truncated, true);
assert.equal(parsed.filter(row => row.jobId === `${run}-cap` && row.batch).length, 2000);
const overhead = {};
for (const mode of ["baseline", "normal", "debug"]) {
	overhead[mode] = lines.filter(line => line.includes(`[SE_PROFILE_LAB]${run}-${mode}-`)).map(line => parseProfiler(line.split("\t").at(-1)));
	assert.equal(overhead[mode].length, 5); assert.ok(overhead[mode].every(value => value !== null && value > 0));
}
mkdirSync("ci-artifacts/timing", { recursive: true });
writeFileSync(`ci-artifacts/timing/${run}.log`, lines.join("\n"));
const report = { run, engine: before.factorio, plugin: before.version, sameTick, wait, capped, overheadMs: overhead };
writeFileSync(`ci-artifacts/timing/${run}.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ run, sameTick: { executionMs: sameTick.executionMs, ticks: sameTick.ticksElapsed }, wait: { elapsedMs: wait.endMs - wait.startMs, executionMs: wait.executionMs, ticks: wait.ticksElapsed }, cap: { recorded: 2000, total: capped.batchCount }, overheadMs: overhead }, null, 2));
