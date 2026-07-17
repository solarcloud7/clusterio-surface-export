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
