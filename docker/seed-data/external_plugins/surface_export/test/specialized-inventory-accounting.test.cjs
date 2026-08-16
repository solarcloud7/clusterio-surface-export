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
	"agricultural-tower", "space-platform-hub",
]);
const handlerFluidOwners = new Set([
	"assembling-machine", "furnace", "fluid-storage", "pipe", "pipe-to-ground", "pump",
	"mining-drill", "loader", "valve", "linked-belt", "plant",
]);
const categories = [
	"assembling-machine", "furnace", "transport-belt", "underground-belt", "splitter",
	"inserter", "container", "fluid-storage", "pipe", "pipe-to-ground", "pump", "train",
	"car", "spider-vehicle", "combinator", "turret", "mining-drill", "lab", "roboport",
	"artillery-turret", "rocket-silo", "gate", "power-switch", "agricultural-tower",
	"programmable-speaker", "lamp", "display-panel", "entity-ghost", "tile-ghost", "item-request-proxy",
	"train-stop", "resource", "space-platform-hub", "loader", "valve", "linked-belt", "plant",
];
const specializedFluidCapabilities = new Map([
	["assembling-machine", { platformReachable: true, evidence: "chemical-plant: 4 fluidboxes, can_place=true" }],
	["fluid-storage", { platformReachable: true, evidence: "storage-tank: 1 fluidbox, can_place=true" }],
	["pipe", { platformReachable: true, evidence: "pipe fluidbox on platform foundation" }],
	["pipe-to-ground", { platformReachable: true, evidence: "pipe-to-ground fluidbox on platform foundation" }],
	["pump", { platformReachable: true, evidence: "pump: 1 fluidbox, can_place=true" }],
	["train", { platformReachable: false, evidence: "fluid-wagon requires gravity>=1; platform gravity=0" }],
	["turret", { platformReachable: false, evidence: "flamethrower-turret requires pressure>=10; platform pressure=0" }],
	["mining-drill", { platformReachable: true, evidence: "big-mining-drill on the omnibus pad: live fluidbox amount 104.40625 measured 2026-07-20" }],
	["space-platform-hub", { platformReachable: false, evidence: "hub on platform-1 and platform-2: fluids_count=0 and the .fluidbox accessor does not exist on the entity (LuaEntity doesn't contain key fluidbox), measured 2026-08-10 — the pre-handler fallback reached FluidRegistry.capture_entity, which returns nil at fluids_count==0, so the handler captures the same nothing" }],
	["loader", { platformReachable: false, evidence: "turbo-loader, loader-1x1, fast-loader: 0 fluidbox_prototypes at 2.1.11 (measured 2026-08-14) — the handler's extract_fluidboxes call is a no-op kept for handler symmetry" }],
	["valve", { platformReachable: true, evidence: "overflow-valve: 1 fluidbox_prototype at 2.1.11 (measured 2026-08-14); placed on a platform clone and survived transfer with its threshold override (config-attrs test)" }],
	["linked-belt", { platformReachable: false, evidence: "linked-belt (the only linked-belt prototype at 2.1.11): 0 fluidbox_prototypes, measured 2026-08-14; create_entity placed one on a platform in the same probe, so the type is reachable while its fluidbox capture is a no-op kept for handler symmetry" }],
	["plant", { platformReachable: false, evidence: "jellystem, yumako-tree, tree-plant, maraxsis-fishing-plant (every plant prototype at 2.1.11): 0 fluidbox_prototypes, measured 2026-08-14; create_entity placed jellystem and yumako-tree on a platform in the same probe, so the type is reachable while its fluidbox capture is a no-op kept for handler symmetry" }],
]);
const ownership = new Map(categories.map(category => [category, {
	inventories: handlerInventoryOwners.has(category) ? "handler" : "shared-dispatcher",
	fluids: handlerFluidOwners.has(category) ? "handler" : "none-required",
	fluidCapability: specializedFluidCapabilities.get(category) || null,
}]));

function parseHandlerAssignments() {
	const assignments = [...source.matchAll(/^EntityHandlers\["([^"]+)"\]\s*=\s*([^\r\n]*)$/gm)];
	const unanchored = [...source.matchAll(/EntityHandlers\["[^"]+"\]\s*=/g)].length;
	assert.equal(assignments.length, unanchored,
		"an EntityHandlers key assignment escaped the line-anchored parse");
	const tail = source.indexOf("\nreturn EntityHandlers");
	assert.notEqual(tail, -1, "entity-handlers.lua must close by returning EntityHandlers");
	assert.ok(assignments.length > 0, "entity-handlers.lua must assign at least one handler key");
	assert.ok(tail > assignments.at(-1).index,
		"the module tail must follow every handler assignment, or the last body slices empty");

	const definitions = new Map();
	const aliases = new Map();
	for (const [index, match] of assignments.entries()) {
		const key = match[1];
		const rhs = match[2].trim();
		assert.ok(!definitions.has(key) && !aliases.has(key), `EntityHandlers["${key}"] is assigned twice`);
		const alias = rhs.match(/^EntityHandlers\["([^"]+)"\]$/);
		if (/^function\s*\([^)]*\)/.test(rhs)) {
			const next = assignments[index + 1];
			definitions.set(key, source.slice(match.index, next ? next.index : tail));
		} else if (alias) {
			aliases.set(key, alias[1]);
		} else {
			assert.fail(`EntityHandlers["${key}"] is neither a function definition nor a handler alias: ${rhs}`);
		}
	}
	return { definitions, aliases };
}

const { definitions: handlerBodies, aliases: handlerAliases } = parseHandlerAssignments();
const fluidboxOptOutDerived = new Set([...handlerBodies]
	.filter(([, body]) => !body.includes("extract_fluidboxes"))
	.map(([category]) => category));

function extractFunctionBody(category) {
	const body = handlerBodies.get(category);
	assert.ok(body, `handler ${category} must exist`);
	return body;
}

const fluidboxOptOut = new Set([
	"transport-belt", "underground-belt", "splitter", "inserter", "container", "train", "car",
	"spider-vehicle", "combinator", "turret", "resource", "lab", "roboport", "artillery-turret",
	"rocket-silo", "gate", "power-switch", "agricultural-tower", "programmable-speaker", "lamp",
	"entity-ghost", "tile-ghost", "item-request-proxy", "space-platform-hub", "display-panel",
	"train-stop",
]);

test("the handler parse found real definitions (a broken matcher must not pass vacuously)", () => {
	assert.ok(handlerBodies.size >= 30,
		`expected every specialized handler, parsed ${handlerBodies.size}`);
	assert.ok(fluidboxOptOutDerived.size >= 20,
		`expected the derived opt-out set to stay populated, derived ${fluidboxOptOutDerived.size}`);
	assert.ok(fluidboxOptOutDerived.has("gate"),
		"gate must stay derived: its handler body carries no extract_fluidboxes call");
	assert.deepEqual(Object.fromEntries(handlerAliases), { "loader-1x1": "loader" },
		"an alias handler runs another handler's body, so it is accounted here instead of in the category matrix");
	for (const [alias, target] of handlerAliases) {
		assert.ok(handlerBodies.has(target), `alias ${alias} must resolve to a parsed handler definition`);
	}
});

test("adding a handler cannot silently drop a type's fluidbox capture", () => {
	assert.deepEqual([...fluidboxOptOutDerived].sort(), [...fluidboxOptOut].sort(),
		"handle_entity attaches fluidboxes ONLY on the no-handler fallback, so giving a previously "
		+ "unhandled type a handler silently stops its fluidbox capture. A change to this set means a "
		+ "type crossed that line: either call InventoryScanner.extract_fluidboxes in the handler, or "
		+ "add it here WITH a specializedFluidCapabilities entry carrying the measurement that says none exist.");
	for (const category of fluidboxOptOut) {
		assert.ok(!handlerFluidOwners.has(category),
			`${category} cannot both opt out of fluidbox capture and be declared a handler fluid owner`);
	}
});

test("every specialized handler has explicit inventory and fluid ownership", () => {
	const actual = [...handlerBodies.keys()];
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
			assert.match(body, /InventoryScanner\.extract_fluidboxes\(entity\)/,
				`${category} owns fluids but does not use extract_fluidboxes (2.1 registry capture)`);
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