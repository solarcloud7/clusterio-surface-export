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

test("the subjects span EXACTLY what the gate counts — including ground items", () => {
	const subjects = new Set(
		Array.from(phaseCensus.matchAll(/PhaseCensus\.SUBJECT_(\w+)\s*=\s*"(\w+)"/g)).map((m) => m[2]),
	);
	assert.deepEqual([...subjects].sort(), ["belts", "ground", "held", "inventories"],
		"the gate's count_items reads four item locations: entity inventories, belt lines, inserter "
		+ "held stacks, and loose item-entity ground stacks. A census missing any of them measures a "
		+ "different set than the verdict and can never reconcile — broken, not partial.");
});

test("the ground subject reads item-entity stacks, which the per-entity meter deliberately omits", () => {
	assert.match(subjectMeterBody, /entity\.type\s*==\s*"item-entity"/,
		"ground counting must key off the item-entity type");
	assert.match(subjectMeterBody, /valid_for_read/,
		"a ground stack must be checked with valid_for_read before it is read, as the gate's ground pass does");
	// The gate's PER-ENTITY meter has no ground branch on purpose (ground is handled in its
	// surface-level fold), so this is the one subject where the two meters legitimately differ.
	assert.doesNotMatch(gateMeterBody, /item-entity/,
		"count_entity_items is expected to have NO ground branch — if it grows one, the primitive "
		+ "agreement test above needs revisiting rather than this one being deleted");
});

test("scope resolves a LuaSurface live, so the census sees what the gate sees", () => {
	assert.match(phaseCensus, /object_name\s*==\s*"LuaSurface"/,
		"a surface scope must be detected and resolved via find_entities_filtered at each snapshot");
	assert.match(phaseCensus, /find_entities_filtered/,
		"the surface scope must use the same enumeration the gate uses");
});

test("the entity-creation baseline is recorded, or upstream-created items belong to no phase", () => {
	assert.match(phaseCensus, /function PhaseCensus\.record_baseline\(/,
		"a baseline recorder must exist: entity creation runs before any bracket opens, so without "
		+ "it every item it produced (including all ground items) is unattributed and the sum under-reports");
	assert.match(importCompletion, /PhaseCensus\.record_baseline\(job,\s*"entity_creation"/,
		"run_phase1 must record the entity_creation baseline");
});

test("the census is reconciled against the gate's actual counts, loudly", () => {
	assert.match(importCompletion, /phase_census_residual/,
		"the residual must be recorded");
	assert.match(importCompletion, /CENSUS RESIDUAL/,
		"a non-empty residual must be logged — silently absorbing it recreates the exact blindness "
		+ "this instrument exists to remove");
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

// ---------------------------------------------------------------------------------------------
// Call-site contracts in import-completion.lua. These pin the two legs where a wrong census
// reading would be actively misleading rather than merely absent.

const importCompletion = stripLuaComments(
	fs.readFileSync(path.join(moduleRoot, "core", "import-completion.lua"), "utf8"),
);

test("a belt restore that THREW records the belts subject as unmeasured, not as zero", () => {
	// The throw leg is the worst place to guess: the restore may have written before it died, so
	// "no delta" is unknown, not nothing. Reporting a clean zero there would state that the belts
	// phase moved nothing on precisely the run where it most likely moved something.
	const throwLeg = importCompletion.slice(
		importCompletion.indexOf("belt_restore_error"),
		importCompletion.indexOf("PhaseCensus.record_external"),
	);
	assert.ok(throwLeg.length > 0, "the belt-restore throw leg must exist");
	assert.match(throwLeg, /PhaseCensus\.close\(job,\s*"belts"/,
		"the throw leg must close the belts phase (which, with no matching open, marks it unmeasured)");
	assert.doesNotMatch(throwLeg, /record_external/,
		"the throw leg must NOT record an externally-measured delta — there is no trustworthy measurement");
});

test("the belts delta is re-keyed into census key format before it is recorded", () => {
	assert.match(importCompletion,
		/PhaseCensus\.record_external\(job,\s*"belts",[\s\S]{0,120}?belt_delta_to_census_keys\(/,
		"the belt bracket keys items name\\0quality while every census uses make_quality_key; "
		+ "recording the raw delta would double normal-quality keys instead of cancelling them");
});

test("the census report is reached on the failure path (no early return can skip it)", () => {
	const phase2 = importCompletion.slice(importCompletion.indexOf("function ImportCompletion.run_phase2"));
	const report = phase2.indexOf("PHASE CENSUS: ");
	assert.ok(report > 0, "run_phase2 must emit the phase census line");
	assert.doesNotMatch(phase2.slice(0, report), /(^|[^_\w])return([^_\w]|$)/,
		"no early return may sit between run_phase2's start and the census report — the line must "
		+ "emit on exactly the failing imports it was built to explain");
});

test("the module is report-only: it never renders a verdict or mutates success", () => {
	assert.doesNotMatch(phaseCensus, /\bsuccess\s*=\s*(true|false)\b/,
		"PhaseCensus is an instrument. Wiring it into the verdict makes it a data-integrity gate "
		+ "change (/di-change), which this pass deliberately is not.");
	assert.doesNotMatch(phaseCensus, /failedStage/,
		"PhaseCensus must not set a failure stage — the exact gate remains the sole verdict");
});
