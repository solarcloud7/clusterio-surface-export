import test from "node:test";
import assert from "node:assert/strict";

import { driftStatus } from "../../tools/clusterio/check-cluster-drift.mjs";


test("disk newer than the load moment is STALE", () => {
	assert.equal(driftStatus(1_000, 2_000), "STALE");
	assert.equal(driftStatus(Date.parse("2026-08-08T22:41:16Z"), Date.parse("2026-08-09T22:27:16Z")), "STALE",
		"the 23.8h Lua drift measured on this cluster 2026-08-09");
});

test("loading after the newest source is FRESH, including a same-instant load", () => {
	assert.equal(driftStatus(2_000, 1_000), "FRESH");
	assert.equal(driftStatus(Date.parse("2026-08-09T23:46:08Z"), Date.parse("2026-08-09T23:46:05Z")), "FRESH");
	assert.equal(driftStatus(1_000, 1_000), "FRESH", "loaded exactly at the source's mtime still has it");
});

test("an unreadable timestamp is UNKNOWN, never FRESH", () => {
	for (const [loaded, disk] of [[null, 1_000], [1_000, null], [null, null], [NaN, 1_000], [1_000, NaN], [undefined, 1_000]]) {
		assert.equal(driftStatus(loaded, disk), "UNKNOWN",
			`driftStatus(${String(loaded)}, ${String(disk)}) must not claim freshness it did not measure`);
	}
});

test("importing the tool does not shell out", () => {
	assert.equal(typeof driftStatus, "function");
});
