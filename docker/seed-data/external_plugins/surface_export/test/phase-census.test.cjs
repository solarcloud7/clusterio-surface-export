"use strict";

// Source-contract tests for the phase census (module/utils/phase-census.lua) and the shared
// subject meter it delegates to (module/validators/surface-counter.lua). Plain `node --test`,
// zero dependencies, fs.readFileSync + structural assertions.
//
// HISTORY THAT SHAPES THIS FILE. This file used to hold drift-detection tests keeping a SECOND
// counting implementation aligned with SurfaceCounter (primitive-set equality, subject-set
// equality, a never-calls-SurfaceCounter ban). Those were deleted 2026-08-08 with the duplicate
// itself: PhaseCensus now delegates to the one meter, so there is nothing left to drift. The
// ban test's own message had enshrined a born-false contract comment ("the destination gate's
// meter ... its readings must not change" — the gate's item loop never called it), which is why
// cross-file behavior claims in this repo live in tests, never in prose.

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

function stripLuaComments(source) {
	return source
		.replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, "")
		.replace(/--[^\n]*/g, "");
}

function countOccurrences(source, needle) {
	return source.split(needle).length - 1;
}

// ---------------------------------------------------------------------------------------------
// The shared subject meter (SurfaceCounter.count_entity_items).

const meterBody = functionBody(
	surfaceCounter,
	"function SurfaceCounter.count_entity_items(entity, subject)",
	"function SurfaceCounter.count_items(surface)",
);

test("the default (nil-subject) read excludes ground items", () => {
	// The source paired census calls this meter one-arg and compares it against serialized data
	// that deliberately excludes ground items. A ground count reachable at subject == nil makes
	// physical > serialized for every loose stack and aborts every transfer carrying one.
	assert.match(stripLuaComments(meterBody), /if subject == "ground" and etype == "item-entity" then/,
		"the ground block must be reachable ONLY under the explicit \"ground\" subject");
	assert.doesNotMatch(meterBody, /subject\s*==\s*nil\s+or\s+subject\s*==\s*"ground"/,
		"ground must never join the nil default");
	assert.equal(countOccurrences(stripLuaComments(meterBody), '"item-entity"'), 1,
		"exactly one item-entity read in the meter body — a second one would be an unguarded path "
		+ "into the default read");
});

test("the three default subjects are individually addressable and jointly the default", () => {
	assert.match(meterBody, /subject == nil or subject == "inventories"/,
		"inventories must run at nil and at its own subject");
	assert.match(meterBody, /\(subject == nil or subject == "belts"\) and GameUtils\.BELT_ENTITY_TYPES\[/,
		"belts must run at nil and at its own subject, gated on the belt type set");
	assert.match(meterBody, /\(subject == nil or subject == "held"\) and etype == "inserter"/,
		"held must run at nil and at its own subject, gated on the inserter type");
});

test("the meter keys items uniformly", () => {
	assert.match(meterBody, /Util\.make_quality_key\(/, "items must key via Util.make_quality_key");
	assert.match(meterBody, /Util\.QUALITY_NORMAL/, "unqualified items must fall back to Util.QUALITY_NORMAL");
});

test("count_items folds the per-entity meter plus the one ground pass", () => {
	const body = functionBody(
		surfaceCounter,
		"function SurfaceCounter.count_items(surface)",
		"function SurfaceCounter.count_entity_fluids",
	);
	assert.match(body, /SurfaceCounter\.count_entity_items\s*\(/,
		"count_items must delegate to the per-entity meter");
	assert.match(body, /SurfaceCounter\.count_ground_items\s*\(/,
		"count_items must take ground from the shared ground pass, not an inline loop");
});

// ---------------------------------------------------------------------------------------------
// PhaseCensus owns bracketing only — counting is delegated.

test("phase-census contains no counting implementation of its own", () => {
	const code = stripLuaComments(phaseCensus);
	assert.match(code, /SurfaceCounter\.count_entity_items\(/,
		"per-subject reads must come from the shared meter");
	assert.doesNotMatch(code, /InventoryScanner/,
		"a direct InventoryScanner call here would be the seed of a second meter — the duplicate "
		+ "this file carried until 2026-08-08, whose drift produced a wrong-scope, missing-subject census");
});

test("scope resolves a LuaSurface live, so the census sees what the gate sees", () => {
	assert.match(phaseCensus, /object_name\s*==\s*"LuaSurface"/,
		"a surface scope must be detected and resolved at each snapshot");
	assert.match(phaseCensus, /find_entities_filtered/,
		"the surface scope must use live enumeration");
});

test("the entity-creation baseline is recorded over every subject including ground", () => {
	const body = functionBody(phaseCensus, "function PhaseCensus.record_baseline(", "function PhaseCensus.total(");
	assert.match(body, /count_subject\(scope,\s*nil\)/, "baseline must take the default read");
	assert.match(body, /count_subject\(scope,\s*PhaseCensus\.SUBJECT_GROUND\)/,
		"baseline must add the ground read — ground items arrive via entity creation and belong to "
		+ "no later phase");
});

test("close() without open() records UNMEASURED, never a zero delta", () => {
	const body = functionBody(phaseCensus, "function PhaseCensus.close(", "function PhaseCensus.record_external(");
	assert.match(body, /unmeasured\s*=\s*true/,
		"a blind phase and a phase that moved nothing must not read the same");
	assert.match(body, /job\.phase_census\[phase\]\s*=\s*\{\s*subject\s*=\s*subject,\s*delta\s*=\s*delta/,
		"close() must store the delta as the phase's record");
	assert.doesNotMatch(body, /before\s*=\s*record\.before/,
		"close() must not persist the raw before/after snapshots");
});

test("diff() keeps negative deltas (a destroyed item is not an absent key)", () => {
	const body = functionBody(phaseCensus, "function PhaseCensus.diff(", "function PhaseCensus.open(");
	assert.match(body, /for\s+key\s+in\s+pairs\(before/, "diff must union the BEFORE keys");
	assert.match(body, /if\s+d\s*~=\s*0\s+then/, "diff must keep every non-zero delta");
});

test("record_external carries the line-set its delta was measured over", () => {
	const body = functionBody(phaseCensus, "function PhaseCensus.record_external(", "function PhaseCensus.record_baseline(");
	assert.match(body, /line_set\s*=\s*line_set/,
		"a belt delta measured over the side-group lines is not commensurate with a whole-platform "
		+ "count; the label prevents a scope mismatch reading as a defect");
});

test("total() reports incompleteness when any phase went unmeasured", () => {
	const body = functionBody(phaseCensus, "function PhaseCensus.total(", "function PhaseCensus.format(");
	assert.match(body, /complete\s*=\s*false/,
		"a partial sum must never be read as an exact reconciliation");
});

test("phase-census is report-only: it never renders a verdict", () => {
	assert.doesNotMatch(phaseCensus, /\bsuccess\s*=\s*(true|false)\b/,
		"wiring the instrument into the verdict is a data-integrity gate change (/di-change)");
	assert.doesNotMatch(phaseCensus, /failedStage/,
		"the exact gate remains the sole verdict");
});

// ---------------------------------------------------------------------------------------------
// Call-site contracts in import-completion.lua.

const importCompletion = stripLuaComments(
	fs.readFileSync(path.join(moduleRoot, "core", "import-completion.lua"), "utf8"),
);

// Phases that move no ITEMS, so they need no census bracket. The reviewable record of that
// judgement, not a convenience.
const ITEM_NEUTRAL_PHASES = {
	state: "control behaviour, filters and circuit connections — no item movement",
	fluids: "fluids are a different unit; accounted by the gate's fluid side, not the item census",
	activation: "flips entity active flags; moves nothing",
	loss_analysis: "post-activation reporting only",
};

test("EVERY recorded phase is either census-bracketed or declared item-neutral", () => {
	const recorded = new Set(
		Array.from(importCompletion.matchAll(/PhaseRecorder\.start\(job,\s*"(\w+)"/g)).map((m) => m[1]),
	);
	assert.ok(recorded.size >= 5, `expected the import's phases to be discoverable, found ${recorded.size}`);

	const bracketed = new Set([
		...Array.from(importCompletion.matchAll(/PhaseCensus\.open\(job,\s*"(\w+)"/g)).map((m) => m[1]),
		...Array.from(importCompletion.matchAll(/PhaseCensus\.record_external\(job,\s*"(\w+)"/g)).map((m) => m[1]),
		...Array.from(importCompletion.matchAll(/PhaseCensus\.record_baseline\(job,\s*"(\w+)"/g)).map((m) => m[1]),
	]);

	const unaccounted = [...recorded].filter((p) => !bracketed.has(p) && !(p in ITEM_NEUTRAL_PHASES));
	assert.deepEqual(unaccounted, [],
		`these phases are recorded but neither census-bracketed nor declared item-neutral: `
		+ `${unaccounted.join(", ")}. Either bracket the phase, or add it to ITEM_NEUTRAL_PHASES `
		+ `with the reason it cannot move items.`);
});

test("run_phase1 records the entity_creation baseline", () => {
	assert.match(importCompletion, /PhaseCensus\.record_baseline\(job,\s*"entity_creation"/,
		"entity creation runs before any bracket opens; without the baseline everything it produced "
		+ "belongs to no phase and the attribution silently under-reports");
});

test("a belt restore that THREW records the belts subject as unmeasured, not as zero", () => {
	const throwLeg = importCompletion.slice(
		importCompletion.indexOf("belt_restore_error"),
		importCompletion.indexOf("PhaseCensus.record_external"),
	);
	assert.ok(throwLeg.length > 0, "the belt-restore throw leg must exist");
	assert.match(throwLeg, /PhaseCensus\.close\(job,\s*"belts"/,
		"the throw leg must close the belts phase (no matching open ⇒ unmeasured)");
	assert.doesNotMatch(throwLeg, /record_external/,
		"the throw leg must NOT record a delta — the restore may have written before it died");
});

test("the belts delta is re-keyed into census key format before it is recorded", () => {
	assert.match(importCompletion,
		/PhaseCensus\.record_external\(job,\s*"belts",[\s\S]{0,120}?belt_delta_to_census_keys\(/,
		"the belt bracket keys items name\\0quality; every census read uses make_quality_key, which "
		+ "drops the suffix for normal quality — summing the raw formats doubles every normal key");
});

test("the census report is reached on the failure path (no early return can skip it)", () => {
	const phase2 = importCompletion.slice(importCompletion.indexOf("function ImportCompletion.run_phase2"));
	const report = phase2.indexOf("PHASE CENSUS: ");
	assert.ok(report > 0, "run_phase2 must emit the phase census line");
	assert.doesNotMatch(phase2.slice(0, report), /(^|[^_\w])return([^_\w]|$)/,
		"the line must emit on exactly the failing imports it was built to explain");
});

test("no runtime census/gate reconciliation exists", () => {
	assert.doesNotMatch(importCompletion, /phase_census_residual|CENSUS RESIDUAL|CENSUS RECONCILED/,
		"the census sum reproduces the gate's own number; comparing them at runtime re-adds a "
		+ "duplicate fact guarded by an agreement check");
	assert.doesNotMatch(importCompletion, /phase_census_total/,
		"no combined total — its only consumer was the deleted reconciliation");
});
