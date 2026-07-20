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
	"mining-drill",
]);
const categories = [
	"assembling-machine", "furnace", "transport-belt", "underground-belt", "splitter",
	"inserter", "container", "fluid-storage", "pipe", "pipe-to-ground", "pump", "train",
	"car", "spider-vehicle", "combinator", "turret", "mining-drill", "lab", "roboport",
	"artillery-turret", "rocket-silo", "gate", "power-switch", "agricultural-tower",
	"programmable-speaker", "lamp", "display-panel", "entity-ghost", "tile-ghost", "item-request-proxy",
	"train-stop", "resource",
];
// Independent prototype/placement evidence from Factorio 2.0.77. This is deliberately
// not derived from handlerFluidOwners: capability is the question, ownership is the answer.
const specializedFluidCapabilities = new Map([
	["assembling-machine", { platformReachable: true, evidence: "chemical-plant: 4 fluidboxes, can_place=true" }],
	["fluid-storage", { platformReachable: true, evidence: "storage-tank: 1 fluidbox, can_place=true" }],
	["pipe", { platformReachable: true, evidence: "pipe fluidbox on platform foundation" }],
	["pipe-to-ground", { platformReachable: true, evidence: "pipe-to-ground fluidbox on platform foundation" }],
	["pump", { platformReachable: true, evidence: "pump: 1 fluidbox, can_place=true" }],
	["train", { platformReachable: false, evidence: "fluid-wagon requires gravity>=1; platform gravity=0" }],
	["turret", { platformReachable: false, evidence: "flamethrower-turret requires pressure>=10; platform pressure=0" }],
	// REFUTED 2026-07-20 by the mining-drill-acid-feed pad: an acid-fed big-mining-drill on the
	// gallery platform (resources present in the gallery mod set) held 104.40625 sulfuric acid in
	// its live fluidbox — the old "fluidbox length 0" reading was for a targetless drill only.
	["mining-drill", { platformReachable: true, evidence: "big-mining-drill on the omnibus pad: live fluidbox amount 104.40625 measured 2026-07-20" }],
]);
const ownership = new Map(categories.map(category => [category, {
	inventories: handlerInventoryOwners.has(category) ? "handler" : "shared-dispatcher",
	fluids: handlerFluidOwners.has(category) ? "handler" : "none-required",
	fluidCapability: specializedFluidCapabilities.get(category) || null,
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
		if (entry.fluidCapability) {
			assert.equal(typeof entry.fluidCapability.platformReachable, "boolean");
			assert.ok(entry.fluidCapability.evidence.length > 0,
				`${category} fluid capability needs independent prototype/placement evidence`);
		}
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
		return entry.fluidCapability?.platformReachable && entry.fluids !== "handler";
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