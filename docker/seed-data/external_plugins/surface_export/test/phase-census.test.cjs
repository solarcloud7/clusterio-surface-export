"use strict";

// Source-contract test for the per-phase, subject-scoped census (module/utils/phase-census.lua).
// Same fs.readFileSync + structural-regex style as census-meter.test.cjs: plain `node --test`,
// zero dependencies.
//
// THE PROPERTY THAT MATTERS. PhaseCensus splits the item count into per-subject pieces so a phase
// can measure only what it owns. That split is only trustworthy if the pieces SUM to the whole —
// i.e. if per-subject counting and SurfaceCounter.count_entity_items (the destination gate's
// meter) read the same things by the same rules. There is no Lua runtime here, so the executable
// form of that property lives in-game; what IS pinnable offline, and what actually regresses, is
// the structural agreement: both must call the SAME InventoryScanner primitives and use the SAME
// quality-key rule. If someone teaches the gate's meter about a fourth item location and does not
// teach PhaseCensus, the per-phase deltas silently stop summing to the gate — and that is exactly
// the blind spot this instrument was built to remove. These tests fail when that happens.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const moduleRoot = path.join(__dirname, "..", "module");
const phaseCensus = fs.readFileSync(path.join(moduleRoot, "utils", "phase-census.lua"), "utf8");
const surfaceCounter = fs.readFileSync(
	path.join(moduleRoot, "validators", "surface-counter.lua"),
	"utf8",
);

function functionBody(source, header, nextHeader) {
	const start = source.indexOf(header);
	assert.notEqual(start, -1, `${header} must exist`);
	const end = source.indexOf(nextHeader, start + header.length);
	return source.slice(start, end === -1 ? source.length : end);
}

/**
 * Strip Lua comments so a dependency assertion reads CODE, not prose.
 * phase-census.lua's header explains at length why it deliberately does NOT build on
 * SurfaceCounter — naming it in order to disclaim it. A raw text search cannot tell that apart
 * from a real call, and deleting the explanation to satisfy the guard would trade the reason
 * away to keep the rule. Strip block comments first (they may span `--` lines), then line ones.
 */
function stripLuaComments(source) {
	return source
		.replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, "")
		.replace(/--[^\n]*/g, "");
}

/** Set of InventoryScanner.<name> primitives referenced in a chunk of Lua source. */
function scannerPrimitives(source) {
	return new Set(
		Array.from(source.matchAll(/InventoryScanner\.(\w+)/g)).map((m) => m[1]),
	);
}

const gateMeterBody = functionBody(
	surfaceCounter,
	"function SurfaceCounter.count_entity_items(entity)",
	"function SurfaceCounter.count_items(surface)",
);
const subjectMeterBody = functionBody(
	phaseCensus,
	"function PhaseCensus.count_entity_subject(entity, subject)",
	"function PhaseCensus.count_subject(",
);

test("the per-subject meter reads the SAME item locations as the gate's per-entity meter", () => {
	const gate = scannerPrimitives(gateMeterBody);
	const subject = scannerPrimitives(subjectMeterBody);
	assert.ok(gate.size > 0, "the gate meter must call InventoryScanner primitives");
	assert.deepEqual(
		[...subject].sort(),
		[...gate].sort(),
		"PhaseCensus.count_entity_subject and SurfaceCounter.count_entity_items must read the same "
		+ "item locations. A primitive in one and not the other means the per-phase deltas no longer "
		+ "sum to the gate's total, which silently reintroduces the unattributable-loss blind spot.",
	);
});

test("the per-subject meter uses the same quality-key rule as the gate meter", () => {
	for (const [label, body] of [["gate", gateMeterBody], ["subject", subjectMeterBody]]) {
		assert.match(body, /Util\.make_quality_key\(/,
			`${label} meter must key items via Util.make_quality_key`);
		assert.match(body, /Util\.QUALITY_NORMAL/,
			`${label} meter must fall back to Util.QUALITY_NORMAL so unqualified items key identically`);
	}
});

test("the per-subject meter gates belts and held items on the same predicates as the gate meter", () => {
	assert.match(subjectMeterBody, /GameUtils\.BELT_ENTITY_TYPES\[/,
		"belt counting must be gated on GameUtils.BELT_ENTITY_TYPES, as the gate meter does");
	assert.match(subjectMeterBody, /entity\.type\s*==\s*"inserter"/,
		"held-item counting must be gated on the inserter type, as the gate meter does");
});

test("phase-census never CALLS SurfaceCounter (the gate's counting path stays untouched)", () => {
	assert.doesNotMatch(stripLuaComments(phaseCensus), /SurfaceCounter/,
		"PhaseCensus must build on the InventoryScanner primitives directly. Reaching into "
		+ "SurfaceCounter would put the destination gate's meter — whose contract says its readings "
		+ "must not change — into the blast radius of every instrument change.");
});

test("all three subjects are addressable and distinct", () => {
	const subjects = new Set(
		Array.from(phaseCensus.matchAll(/PhaseCensus\.SUBJECT_(\w+)\s*=\s*"(\w+)"/g)).map((m) => m[2]),
	);
	assert.deepEqual([...subjects].sort(), ["belts", "held", "inventories"],
		"exactly the three item-bearing subjects must be addressable");
});

test("close() persists the delta and DROPS the raw snapshots (storage-safe)", () => {
	const body = functionBody(phaseCensus, "function PhaseCensus.close(", "function PhaseCensus.record_external(");
	assert.match(body, /job\.phase_census\[phase\]\s*=\s*\{\s*subject\s*=\s*subject,\s*delta\s*=\s*delta/,
		"close() must store the delta as the phase's record");
	assert.doesNotMatch(body, /before\s*=\s*record\.before/,
		"close() must not persist the raw before/after maps — the delta is the product");
});

test("a phase closed without an open is recorded UNMEASURED, never as a zero delta", () => {
	const body = functionBody(phaseCensus, "function PhaseCensus.close(", "function PhaseCensus.record_external(");
	assert.match(body, /unmeasured\s*=\s*true/,
		"close() without a matching open() must mark the phase unmeasured. Reporting it as a zero "
		+ "delta would make a blind phase indistinguishable from a phase that moved nothing.");
});

test("total() reports incompleteness when any phase went unmeasured", () => {
	const body = functionBody(phaseCensus, "function PhaseCensus.total(", "function PhaseCensus.format(");
	assert.match(body, /complete\s*=\s*false/,
		"total() must flag the sum as incomplete when a phase is unmeasured, so a partial sum is "
		+ "never read as an exact reconciliation");
});

test("diff() keeps negative deltas (a destroyed item is not an absent key)", () => {
	const body = functionBody(phaseCensus, "function PhaseCensus.diff(", "function PhaseCensus.open(");
	assert.match(body, /for\s+key\s+in\s+pairs\(before/,
		"diff() must union the BEFORE keys, or a key that vanished entirely reports no delta");
	assert.match(body, /if\s+d\s*~=\s*0\s+then/,
		"diff() must keep every non-zero delta, negative ones included");
});

test("the belts phase records an externally-measured delta with its line-set labelled", () => {
	const body = functionBody(phaseCensus, "function PhaseCensus.record_external(", "function PhaseCensus.total(");
	assert.match(body, /line_set\s*=\s*line_set/,
		"record_external must carry the line-set the delta was measured over. Belts never freeze, so "
		+ "a belt delta measured over the side-group lines is not commensurate with one measured over "
		+ "all platform belts — comparing them would make a scope mismatch look like a defect.");
});

test("the module is report-only: it never renders a verdict or mutates success", () => {
	assert.doesNotMatch(phaseCensus, /\bsuccess\s*=\s*(true|false)\b/,
		"PhaseCensus is an instrument. Wiring it into the verdict makes it a data-integrity gate "
		+ "change (/di-change), which this pass deliberately is not.");
	assert.doesNotMatch(phaseCensus, /failedStage/,
		"PhaseCensus must not set a failure stage — the exact gate remains the sole verdict");
});
