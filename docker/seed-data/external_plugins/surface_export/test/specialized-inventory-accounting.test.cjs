"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const handlersPath = path.join(__dirname, "..", "module", "export_scanners", "entity-handlers.lua");
const source = fs.readFileSync(handlersPath, "utf8");

const handlerInventoryOwners = new Set([
	"assembling-machine", "furnace", "container", "train", "car", "spider-vehicle",
	"turret", "mining-drill", "lab", "roboport", "artillery-turret", "rocket-silo",
	"agricultural-tower",
]);
const handlerFluidOwners = new Set([
	"assembling-machine", "furnace", "fluid-storage", "pipe", "pipe-to-ground", "pump",
]);
const categories = [
	"assembling-machine", "furnace", "transport-belt", "underground-belt", "splitter",
	"inserter", "container", "fluid-storage", "pipe", "pipe-to-ground", "pump", "train",
	"car", "spider-vehicle", "combinator", "turret", "mining-drill", "lab", "roboport",
	"artillery-turret", "rocket-silo", "gate", "power-switch", "agricultural-tower",
	"programmable-speaker", "lamp", "entity-ghost", "tile-ghost", "item-request-proxy",
	"train-stop",
];
const fluidCapableOnPlatforms = new Set(handlerFluidOwners);
const ownership = new Map(categories.map(category => [category, {
	inventories: handlerInventoryOwners.has(category) ? "handler" : "shared-dispatcher",
	fluids: handlerFluidOwners.has(category) ? "handler" : "none-required",
	platformReachableFluidCapable: fluidCapableOnPlatforms.has(category),
}]));

function extractFunctionBody(category) {
	const marker = `EntityHandlers["${category}"] = function(entity)`;
	const start = source.indexOf(marker);
	assert.notEqual(start, -1, `handler ${category} must exist`);
	const next = source.indexOf("\nEntityHandlers[\"", start + marker.length);
	const end = next === -1 ? source.indexOf("\nreturn EntityHandlers", start) : next;
	assert.notEqual(end, -1, `handler ${category} must have a bounded body`);
	return source.slice(start, end);
}

test("every specialized handler has explicit inventory and fluid ownership", () => {
	const actual = [...source.matchAll(/EntityHandlers\["([^"]+)"\]\s*=\s*function\(entity\)/g)]
		.map(match => match[1]);
	assert.deepEqual(actual.sort(), [...categories].sort(),
		"new specialized handlers must declare inventory and fluid ownership in the matrix");
	for (const category of categories) {
		const entry = ownership.get(category);
		assert.ok(entry, `${category} must have ownership metadata`);
		assert.ok(["handler", "shared-dispatcher", "none-required"].includes(entry.inventories));
		assert.ok(["handler", "shared-dispatcher", "none-required"].includes(entry.fluids));
		assert.equal(typeof entry.platformReachableFluidCapable, "boolean");
	}
});

test("handler-owned cross-cutting state always uses the canonical scanners", () => {
	for (const category of categories) {
		const entry = ownership.get(category);
		const body = extractFunctionBody(category);
		if (entry.inventories === "handler") {
			assert.match(body, /InventoryScanner\.extract_all_inventories\(entity\)/,
				`${category} owns inventories but does not use extract_all_inventories`);
		}
		if (entry.fluids === "handler") {
			assert.match(body, /InventoryScanner\.extract_fluids\(entity\)/,
				`${category} owns fluids but does not use extract_fluids`);
		}
	}
});

test("platform-reachable specialized fluidboxes are already handler-owned", () => {
	const uncovered = categories.filter(category => {
		const entry = ownership.get(category);
		return entry.platformReachableFluidCapable && entry.fluids !== "handler";
	});
	assert.deepEqual(uncovered, [],
		"a reachable specialized fluidbox omission requires the symmetric shared fluid repair");
});

test("the dispatcher attaches missing ordinary inventories after category dispatch", () => {
	assert.match(source, /function\s+EntityHandlers\.attach_missing_inventories\s*\(\s*entity\s*,\s*data\s*\)/,
		"shared inventory attachment helper is required");
	assert.match(source, /data\s*=\s*EntityHandlers\.attach_missing_inventories\(entity,\s*data\)/,
		"both specialized and default paths must pass through shared inventory attachment");
	assert.match(source, /if\s+data\.inventories\s*==\s*nil\s+then[\s\S]*InventoryScanner\.extract_all_inventories\(entity\)/,
		"existing handler-owned inventories must remain authoritative while missing inventories are scanned");
});