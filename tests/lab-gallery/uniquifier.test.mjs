import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { exportIdFloor } from "./batch-lifecycle.mjs";

const T = 1785604898997;

test("the floor does not alias at either wrap period the old offsets had", () => {
	assert.notEqual(exportIdFloor(T), exportIdFloor(T + 1_000_000),
		"batch-lifecycle's old `% 1_000_000` aliased on a 16m40s cycle — two runs that far apart "
		+ "regenerated identical transfer IDs");
	assert.notEqual(exportIdFloor(T), exportIdFloor(T + 100_000),
		"deliver-all-fixtures' old `% 100_000` aliased on a 100-SECOND cycle");
});

test("the floor is strictly increasing across a long sweep, not just at two points", () => {
	let t = T;
	let previous = exportIdFloor(t);
	for (let i = 1; i < 1200; i++) {
		t += 1_777;
		const value = exportIdFloor(t);
		assert.ok(value > previous,
			`floor went backwards for a forward clock: t=${t} gave ${value} after ${previous}`);
		previous = value;
	}
	assert.ok(t - T > 2_000_000, "the sweep must cross the 16m40s period at least twice");
});

test("advancing the clock by either old wrap period always changes the floor", () => {
	for (let i = 0; i < 500; i++) {
		const t = T + i * 3_331;
		for (const period of [100_000, 1_000_000]) {
			assert.notEqual(exportIdFloor(t), exportIdFloor(t + period),
				`floor aliases at ${period} ms — the defect this replaced, at t=${t}`);
		}
	}
});

test("the floor carries no modulus — it is the raw millisecond", () => {
	assert.equal(exportIdFloor(T), T);
	assert.equal(exportIdFloor(T + 1), T + 1);
	assert.equal(exportIdFloor(8_000_000_000_000), 8_000_000_000_000,
		"a value beyond any plausible modulus must pass through untouched — a clamp or a large "
		+ "modulus reads as monotone for years and then silently aliases forever");
	assert.equal(exportIdFloor(Number.MAX_SAFE_INTEGER - 1), Number.MAX_SAFE_INTEGER - 1);
});

test("the floor is an integer — it becomes a Lua number and a %03d-formatted id", () => {
	for (const t of [T, T + 0.5, T + 0.999]) {
		assert.ok(Number.isInteger(exportIdFloor(t)), `exportIdFloor(${t}) must be an integer`);
	}
	assert.ok(exportIdFloor(T) < Number.MAX_SAFE_INTEGER,
		"the counter is a Lua double; above 2^53 the `^(%d+)_` parse would stop round-tripping exactly");
});

test("the counter bump is SET-if-lower, never ADD (source-text pin on the embedded Lua)", () => {
	const src = readFileSync(new URL("./batch-lifecycle.mjs", import.meta.url), "utf8");
	assert.match(src, /if before < floor then storage\.async_job_id_counter = floor end/,
		"bumpExportIdCounter's embedded Lua no longer sets the counter TO the floor when lower - "
		+ "SET-if-lower is what lands both hosts on the SAME base regardless of drift");
	assert.doesNotMatch(src, /async_job_id_counter\s*=\s*(?:before|storage\.async_job_id_counter)\s*\+/,
		"an ADDITIVE counter bump is the aliasing defect this uniquifier replaced - "
		+ "it must not reappear in any form");
});
