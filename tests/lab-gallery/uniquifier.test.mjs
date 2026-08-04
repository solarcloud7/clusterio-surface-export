// Offline pin for the export-ID uniquifier (tests/lab-gallery/batch-lifecycle.mjs).
//
// WHY. The suite raises each host's export-ID counter after loading a golden save, because the
// golden world's deterministic counter would otherwise regenerate IDENTICAL transfer IDs every run
// and the controller correctly refuses a same-ID retry of a settled transfer.
//
// The bump used to be an ADDITIVE modular offset:
//
//     batch-lifecycle.mjs      100 + (Date.now() % 1_000_000)     wraps every 16m40s
//     deliver-all-fixtures.mjs 500 + (Date.now() %   100_000)     wraps every 100 SECONDS
//
// The golden save reloads to a PINNED counter, so the post-bump value was fully determined by the
// offset. Two runs any multiple of the wrap period apart therefore drew the same offset and
// regenerated the SAME IDs. That is why collisions kept RECURRING — they were not stray manual
// contamination, they were the uniquifier aliasing against itself. It cost suite runs on
// 2026-07-29, 07-30 and 07-31 before the mechanism was suspected.
//
// A green suite cannot see this: the aliasing only bites when a *previous* run's ID happens to be
// settled in the controller's in-memory registry, which depends on timing between runs. So the pin
// has to be here, on the arithmetic itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { exportIdFloor } from "./batch-lifecycle.mjs";

// A fixed instant, so these assertions do not depend on when the suite runs.
const T = 1785604898997;

test("the floor does not alias at either wrap period the old offsets had", () => {
	// The direct anti-regression. `100 + (t % 1_000_000)` returns the same value for t and
	// t + 1_000_000; so does `500 + (t % 100_000)` for t and t + 100_000. Both must now differ.
	assert.notEqual(exportIdFloor(T), exportIdFloor(T + 1_000_000),
		"batch-lifecycle's old `% 1_000_000` aliased on a 16m40s cycle — two runs that far apart "
		+ "regenerated identical transfer IDs");
	assert.notEqual(exportIdFloor(T), exportIdFloor(T + 100_000),
		"deliver-all-fixtures' old `% 100_000` aliased on a 100-SECOND cycle");
});

test("the floor is strictly increasing across a long sweep, not just at two points", () => {
	// A monotone clock must produce a monotone floor. The sweep spans ~35 minutes of wall clock, so
	// it crosses both old wrap periods many times over — a modular offset is strictly increasing
	// WITHIN a period and only betrays itself at the wrap, which two sample points can miss.
	let t = T;
	let previous = exportIdFloor(t);
	for (let i = 1; i < 1200; i++) {
		t += 1_777;   // varied only in that it is coprime with neither old period
		const value = exportIdFloor(t);
		assert.ok(value > previous,
			`floor went backwards for a forward clock: t=${t} gave ${value} after ${previous}`);
		previous = value;
	}
	assert.ok(t - T > 2_000_000, "the sweep must cross the 16m40s period at least twice");
});

test("advancing the clock by either old wrap period always changes the floor", () => {
	// The aliasing stated directly, sampled across a range rather than at one instant: the old
	// expressions returned the SAME value for t and t + period, for every t. This is the assertion
	// that a future "just widen the modulus" edit has to fail.
	for (let i = 0; i < 500; i++) {
		const t = T + i * 3_331;
		for (const period of [100_000, 1_000_000]) {
			assert.notEqual(exportIdFloor(t), exportIdFloor(t + period),
				`floor aliases at ${period} ms — the defect this replaced, at t=${t}`);
		}
	}
});

test("the floor carries no modulus — it is the raw millisecond", () => {
	// Stated as an equality rather than a range: any modulus, of any size, reintroduces a wrap.
	// A future "just make the period longer" edit fails here instead of aliasing quietly in a year.
	assert.equal(exportIdFloor(T), T);
	assert.equal(exportIdFloor(T + 1), T + 1);
	// Review found this test overstated itself: it claimed "any modulus, of any size" fails here, and
	// `nowMs => nowMs % 2_000_000_000_000` passed all five — it only aliases from 2033. So does
	// `Math.min(nowMs, 1_900_000_000_000)`, which goes CONSTANT in 2030. Probing far past any
	// plausible modulus is what makes the claim true.
	assert.equal(exportIdFloor(8_000_000_000_000), 8_000_000_000_000,
		"a value beyond any plausible modulus must pass through untouched — a clamp or a large "
		+ "modulus reads as monotone for years and then silently aliases forever");
	assert.equal(exportIdFloor(Number.MAX_SAFE_INTEGER - 1), Number.MAX_SAFE_INTEGER - 1);
});

test("the floor is an integer — it becomes a Lua number and a %03d-formatted id", () => {
	// Measured on 2.1.11: string.format("%03d", 1785604898997) formats clean, the id round-trips
	// through job-results.lua:12's `^(%d+)_` parse exactly, and the counter survives save/load.
	// That measurement assumes an integer; a fractional millisecond would break %d.
	for (const t of [T, T + 0.5, T + 0.999]) {
		assert.ok(Number.isInteger(exportIdFloor(t)), `exportIdFloor(${t}) must be an integer`);
	}
	assert.ok(exportIdFloor(T) < Number.MAX_SAFE_INTEGER,
		"the counter is a Lua double; above 2^53 the `^(%d+)_` parse would stop round-tripping exactly");
});

test("the counter bump is SET-if-lower, never ADD (source-text pin on the embedded Lua)", () => {
	// The bump Lua is an embedded string, invisible to every runtime test: reverting SET-if-lower to
	// an ADD passes the whole offline suite while silently restoring the additive aliasing above
	// (both hosts drift apart again and the collision preflight predicts from a base neither host
	// has). Pin the protective shape in the source text, id-format-pin style.
	const src = readFileSync(new URL("./batch-lifecycle.mjs", import.meta.url), "utf8");
	assert.match(src, /if before < floor then storage\.async_job_id_counter = floor end/,
		"bumpExportIdCounter's embedded Lua no longer sets the counter TO the floor when lower - "
		+ "SET-if-lower is what lands both hosts on the SAME base regardless of drift");
	assert.doesNotMatch(src, /async_job_id_counter\s*=\s*(?:before|storage\.async_job_id_counter)\s*\+/,
		"an ADDITIVE counter bump is the aliasing defect this uniquifier replaced - "
		+ "it must not reappear in any form");
});
