"use strict";


const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const moduleRoot = path.join(__dirname, "..", "module");
const surfaceCounter = fs.readFileSync(
	path.join(moduleRoot, "validators", "cargo-counter.lua"),
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


const meterBody = functionBody(
	surfaceCounter,
	"function CargoCounter.count_entity_items(entity, subject)",
	"function CargoCounter.count_items(surface)",
);

test("the default (nil-subject) read excludes ground items", () => {
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
	assert.equal(countOccurrences(stripLuaComments(meterBody), "subject == nil"), 3,
		"exactly three nil-reachable blocks — a NEW nil-reachable subject would silently change "
		+ "the verdict-bearing default read at every gate and source-census call site");
});


test("the meter keys items uniformly", () => {
	assert.match(surfaceCounter, /Util\.make_quality_key\(/, "items must key via Util.make_quality_key");
	assert.match(surfaceCounter, /Util\.QUALITY_NORMAL/, "unqualified items must fall back to Util.QUALITY_NORMAL");
});


test("count_items folds the per-entity meter plus the one ground pass", () => {
	const body = functionBody(
		surfaceCounter,
		"function CargoCounter.count_items(surface)",
		"function CargoCounter.count_entity_fluids",
	);
	assert.match(body, /CargoCounter\.count_entity_items\s*\(/,
		"count_items must delegate to the per-entity meter");
	assert.match(body, /CargoCounter\.count_ground_items\s*\(/,
		"count_items must take ground from the shared ground pass, not an inline loop");
});


