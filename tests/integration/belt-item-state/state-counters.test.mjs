import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStateCounters } from "./state-counters.mjs";

const record = (counts, clone = "beltstate-test") =>
	`12.345 Script @belt_restoration.lua:560: [BeltRestoration] ITEM STATE ${clone}: `
	+ `applied ${counts[0]} | unmatched ${counts[1]} | failed ${counts[2]} `
	+ `| merge-discarded ${counts[3]} | declined ${counts[4]}`;

test("belt state evidence totals every batch, including identical consecutive records", () => {
	const line = record([4, 0, 0, 0, 0]);
	const counters = parseStateCounters(`${line}\r\n${line}`, "beltstate-test");
	assert.equal(counters.applied, 8);
	assert.equal(counters.records, 2);
	assert.equal(counters.line, `${line}\n${line}`);
});

test("a clean final batch cannot hide an earlier state restoration failure", () => {
	const counters = parseStateCounters([
		record([1, 2, 3, 4, 5]), record([4, 0, 0, 0, 0]),
	].join("\n"), "beltstate-test");
	assert.deepEqual([counters.applied, counters.unmatched, counters.failed,
		counters.mergeDiscarded, counters.declined], [5, 2, 3, 4, 5]);
});

test("only the exact clone's records contribute to its totals", () => {
	const counters = parseStateCounters([
		record([99, 99, 99, 99, 99], "beltstate-test-other"), record([8, 0, 0, 0, 0]),
	].join("\n"), "beltstate-test");
	assert.equal(counters.applied, 8);
	assert.equal(counters.records, 1);
	assert.equal(parseStateCounters("unrelated output", "beltstate-test"), null);
});

test("malformed matching evidence is rejected even before a valid final batch", () => {
	assert.throws(() => parseStateCounters([
		record([1, 0, 0, 0, 0]).replace("applied 1", "applied unknown"),
		record([8, 0, 0, 0, 0]),
	].join("\n"), "beltstate-test"), /Malformed/);
});

test("unsafe counters and aggregate overflow cannot become trustworthy totals", () => {
	assert.throws(() => parseStateCounters(record(["9007199254740992", 0, 0, 0, 0]),
		"beltstate-test"), /Unsafe/);
	assert.throws(() => parseStateCounters([
		record([Number.MAX_SAFE_INTEGER, 0, 0, 0, 0]), record([1, 0, 0, 0, 0]),
	].join("\n"), "beltstate-test"), /Unsafe/);
});
