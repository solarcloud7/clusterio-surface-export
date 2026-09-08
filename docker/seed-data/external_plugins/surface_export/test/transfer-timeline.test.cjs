"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { buildTransferTimeline, mergeIntervals, gapsWithin } = require("../dist/node/shared/transfer-timeline");
const fixtures = require("./fixtures/real-transfer-timelines.json");

test("overlapping measured intervals count coverage once without changing boundaries", () => {
 assert.deepEqual(mergeIntervals([[0,10],[5,20],[30,40]]), [[0,20],[30,40]]);
 assert.deepEqual(gapsWithin([[0,10],[20,30]], 40), [[10,20],[30,40]]);
});
for (const fixture of fixtures) {
 test(`${fixture.label}: tick evidence cannot affect waterfall geometry or measured coverage`, () => {
  const original = buildTransferTimeline(fixture.events, null);
  const modified = fixture.events.map(event => ({ ...event,
   importMetrics: { total_ms: 99999999, phaseSpans: [{ name: "entities", durationMs: 9999999, startOffsetMs: 1234 }] },
   exportMetrics: { ...event.exportMetrics, instanceAsyncExportMs: 99999999, instanceAsyncExportTicks: 99999 },
  }));
  assert.deepEqual(buildTransferTimeline(modified, null), original);
  assert.ok(original.rows.every(row => row.kind === "measured" || row.kind === "event"));
  assert.equal(original.attribution.detailGapMs, 0);
  assert.equal(original.attribution.attributedMs + original.attribution.residualMs, original.totalMs);
 });
}
test("request round trip and completion wait retain separate controller boundaries", () => {
 const { rows } = buildTransferTimeline([
  { eventType: "import_started", elapsedMs: 45, transmissionMs: 43 },
  { eventType: "validation_received", elapsedMs: 81, validationMs: 36 },
  { eventType: "transfer_completed", elapsedMs: 124, phases: { cleanupMs: 43, exportTickEstimateMs: 999 } },
 ], null);
 assert.deepEqual(rows.filter(row => row.kind === "measured").map(row => [row.startMs,row.endMs]), [[2,45],[45,81],[81,124]]);
 assert.match(rows.find(row => row.startMs===2).label, /round trip/);
});
test("export request anchors preserve actual observed boundaries", () => {
 const { rows } = buildTransferTimeline([
  { eventType: "export_requested", elapsedMs: 0 },
  { eventType: "export_returned", elapsedMs: 125, requestExportAndLockMs: 9999 },
 ], null);
 assert.deepEqual(rows.filter(row => row.kind === "measured").map(row => [row.startMs,row.endMs]), [[0,125]]);
});
test("missing elapsed boundaries produce no guessed phase geometry", () => {
 const { rows } = buildTransferTimeline([{ eventType: "export_returned", requestExportAndLockMs: 500 }], null);
 assert.deepEqual(rows, []);
});
test("overlapping inclusive measurements are not trimmed or added together", () => {
 const { rows, attribution } = buildTransferTimeline([
  { eventType: "import_started", elapsedMs: 100, transmissionMs: 100 },
  { eventType: "validation_received", elapsedMs: 120, validationMs: 100 },
 ], null);
 assert.deepEqual(rows.filter(row => row.kind === "measured").map(row => [row.startMs,row.endMs]), [[0,100],[20,120]]);
 assert.equal(attribution.attributedMs,120);
});
