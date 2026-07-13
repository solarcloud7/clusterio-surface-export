"use strict";

// Source-contract test for the per-entity census meter (Task 2, Phase 1).
// Follows the fs.readFileSync + structural-regex style of composite-transfer-verdict.test.cjs:
// plain `node --test`, zero dependencies, asserts the SHAPE of the Lua source so the
// per-entity extraction (and its independence from EntityHandlers) cannot silently regress.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const moduleRoot = path.join(__dirname, "..", "module");
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

test("surface-counter defines the per-entity item and fluid census meters", () => {
	assert.match(surfaceCounter, /function\s+SurfaceCounter\.count_entity_items\s*\(\s*entity/,
		"count_entity_items(entity) must be the extracted per-entity item meter");
	assert.match(surfaceCounter, /function\s+SurfaceCounter\.count_entity_fluids\s*\(\s*entity/,
		"count_entity_fluids(entity, ...) must be the extracted per-entity fluid meter");
});

test("count_items is a fold over the per-entity item meter (one meter, not two)", () => {
	const body = functionBody(
		surfaceCounter,
		"function SurfaceCounter.count_items(surface)",
		"function SurfaceCounter.count_fluids",
	);
	assert.match(body, /SurfaceCounter\.count_entity_items\s*\(/,
		"count_items must delegate to count_entity_items so the surface census and the per-entity census share one meter");
});

test("count_fluids is a fold over the per-entity fluid meter", () => {
	const body = functionBody(
		surfaceCounter,
		"function SurfaceCounter.count_fluids(surface",
		"function SurfaceCounter.count_all",
	);
	assert.match(body, /SurfaceCounter\.count_entity_fluids\s*\(/,
		"count_fluids must delegate to count_entity_fluids so both censuses share one fluid meter");
});

test("surface-counter never references EntityHandlers (independence is structural)", () => {
	assert.doesNotMatch(surfaceCounter, /EntityHandlers/,
		"the census meter must stay independent of the export-side EntityHandlers dispatch");
});

// -----------------------------------------------------------------------------
// Task 3 (Phase 1): paired-reads census accumulator — source-contract assertions.
// Read lazily so a missing module fails ONLY these tests (clean RED), not the
// surface-counter tests above.
// -----------------------------------------------------------------------------
function accumulatorSource() {
	return fs.readFileSync(
		path.join(moduleRoot, "export_scanners", "census-accumulator.lua"),
		"utf8",
	);
}

test("census-accumulator defines new/record/verdict", () => {
	const src = accumulatorSource();
	assert.match(src, /function\s+CensusAccumulator\.new\s*\(/,
		"CensusAccumulator.new() must create the accumulator");
	assert.match(src, /function\s+CensusAccumulator\.record\s*\(\s*acc\s*,\s*entity\s*,\s*entity_data/,
		"record(acc, entity, entity_data, ...) must take the paired reads for one entity");
	assert.match(src, /function\s+CensusAccumulator\.verdict\s*\(\s*acc/,
		"verdict(acc) must produce the census verdict");
});

test("record performs the paired PHYSICAL read via the Task-2 SurfaceCounter meters (real wiring, not a stub)", () => {
	const body = functionBody(
		accumulatorSource(),
		"function CensusAccumulator.record(",
		"function CensusAccumulator.verdict",
	);
	assert.match(body, /SurfaceCounter\.count_entity_items\s*\(\s*entity/,
		"record must call SurfaceCounter.count_entity_items(entity) — the physical item read is the paired-read wiring");
	assert.match(body, /SurfaceCounter\.count_entity_fluids\s*\(\s*entity/,
		"record must call SurfaceCounter.count_entity_fluids(entity, ...) for the physical fluid read");
});

test("record's SERIALIZED side reuses Verification's counting rules (no re-implementation)", () => {
	const body = functionBody(
		accumulatorSource(),
		"function CensusAccumulator.record(",
		"function CensusAccumulator.verdict",
	);
	assert.match(body, /Verification\.count_all_items\s*\(/,
		"the serialized item count must reuse Verification.count_all_items");
	assert.match(body, /Verification\.count_all_fluids\s*\(/,
		"the serialized fluid count must reuse Verification.count_all_fluids");
});

test("mismatch rows carry unit_number and per-key expected/actual/delta (belt-attribution row shape)", () => {
	const src = accumulatorSource();
	assert.match(src, /unit_number\s*=\s*entity\.unit_number/,
		"rows must be entity-attributed by the stable unit_number");
	assert.match(src, /entity_id\s*=/, "rows must carry the serialized entity_id");
	assert.match(src, /position\s*=\s*\{\s*x\s*=\s*entity\.position\.x/,
		"rows must carry a COPIED position (scalars only — storage-safe, never the position userdata)");
	assert.match(src, /\bexpected\s*=/, "rows must carry per-key expected");
	assert.match(src, /\bactual\s*=/, "rows must carry per-key actual");
	assert.match(src, /\bdelta\s*=/, "rows must carry per-key delta");
});

test("verdict compares items EXACTLY and fluids within the 1e-6 epsilon constant", () => {
	const src = accumulatorSource();
	assert.match(src, /(?:EXACT_EPSILON|epsilon)\s*=\s*1e-6/,
		"the fluid comparison must use the 1e-6 epsilon constant (mirrors the transfer gate)");
	assert.match(src, /math\.abs\([^)]*\)\s*>\s*EXACT_EPSILON/,
		"fluid names compare with |delta| > EXACT_EPSILON");
});

test("accumulator aggregates temp-keyed fluids to per-name totals for the verdict (mirrors the gate)", () => {
	const src = accumulatorSource();
	assert.match(src, /Util\.parse_fluid_temp_key\s*\(/,
		"fluids must be re-aggregated temp-key → name via Util.parse_fluid_temp_key, as the gate does");
});
