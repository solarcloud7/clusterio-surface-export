"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const gameUtilsPath = path.join(__dirname, "..", "module", "utils", "game-utils.lua");
const handlersPath = path.join(__dirname, "..", "module", "export_scanners", "entity-handlers.lua");
const gameUtilsSource = fs.readFileSync(gameUtilsPath, "utf8");
const handlersSource = fs.readFileSync(handlersPath, "utf8");

const ENTITY_TYPES_AT_PIN_2_1_11 = [
	"accumulator", "agricultural-tower", "ammo-turret", "arithmetic-combinator", "arrow",
	"artillery-flare", "artillery-projectile", "artillery-turret", "artillery-wagon",
	"assembling-machine", "asteroid", "asteroid-collector", "beacon", "beam", "boiler",
	"burner-generator", "capture-robot", "car", "cargo-bay", "cargo-landing-pad", "cargo-pod",
	"cargo-wagon", "character", "character-corpse", "cliff", "combat-robot", "constant-combinator",
	"construction-robot", "container", "corpse", "curved-rail-a", "curved-rail-b",
	"decider-combinator", "deconstructible-tile-proxy", "display-panel",
	"electric-energy-interface", "electric-pole", "electric-turret", "elevated-curved-rail-a",
	"elevated-curved-rail-b", "elevated-half-diagonal-rail", "elevated-straight-rail",
	"entity-ghost", "explosion", "fire", "fish", "fluid-turret", "fluid-wagon", "furnace",
	"fusion-generator", "fusion-reactor", "gate", "generator", "half-diagonal-rail",
	"heat-interface", "heat-pipe", "highlight-box", "infinity-cargo-wagon", "infinity-container",
	"infinity-pipe", "inserter", "item-entity", "item-request-proxy", "lab", "lamp", "land-mine",
	"lane-splitter", "legacy-curved-rail", "legacy-straight-rail", "lightning",
	"lightning-attractor", "linked-belt", "linked-container", "loader", "loader-1x1", "locomotive",
	"logistic-container", "logistic-robot", "market", "mining-drill", "offshore-pump",
	"particle-source", "pipe", "pipe-to-ground", "plant", "power-switch", "programmable-speaker",
	"projectile", "proxy-container", "pump", "radar", "rail-chain-signal", "rail-ramp",
	"rail-remnants", "rail-signal", "rail-support", "reactor", "resource", "roboport",
	"rocket-silo", "rocket-silo-rocket", "rocket-silo-rocket-shadow", "segment", "segmented-unit",
	"selector-combinator", "simple-entity", "simple-entity-with-force", "simple-entity-with-owner",
	"smoke-with-trigger", "solar-panel", "space-platform-hub", "speech-bubble", "spider-leg",
	"spider-unit", "spider-vehicle", "splitter", "sticker", "storage-tank", "straight-rail",
	"stream", "temporary-container", "thruster", "tile-ghost", "train-stop", "transport-belt",
	"tree", "turret", "underground-belt", "unit", "unit-spawner", "valve", "wall",
];

function extractTypeToCategory() {
	const marker = "GameUtils.TYPE_TO_CATEGORY = {";
	const start = gameUtilsSource.indexOf(marker);
	assert.notEqual(start, -1, "GameUtils.TYPE_TO_CATEGORY must exist in game-utils.lua");
	const end = gameUtilsSource.indexOf("\n}", start);
	assert.notEqual(end, -1, "TYPE_TO_CATEGORY must be a closed table");
	const body = gameUtilsSource.slice(start + marker.length, end);
	const rows = [...body.matchAll(/\["([^"]+)"\]\s*=\s*"([^"]+)"/g)];
	return new Map(rows.map(m => [m[1], m[2]]));
}

function extractHandlerKeys() {
	return [...handlersSource.matchAll(/^EntityHandlers\["([^"]+)"\]\s*=/gm)].map(m => m[1]);
}

const typeToCategory = extractTypeToCategory();
const handlerKeys = extractHandlerKeys();
const categoryOf = entityType => typeToCategory.get(entityType) ?? entityType;
const reachableCategories = new Set(ENTITY_TYPES_AT_PIN_2_1_11.map(categoryOf));

test("the parsers found real data (a broken parser must not pass vacuously)", () => {
	assert.ok(typeToCategory.size >= 15,
		`expected many mapping rows, parsed ${typeToCategory.size}`);
	assert.ok(handlerKeys.length >= 30,
		`expected many handler keys, parsed ${handlerKeys.length}`);
	assert.equal(ENTITY_TYPES_AT_PIN_2_1_11.length, 132,
		"the pinned entity-type set must stay the measured set");
	for (const known of ["container", "train", "turret", "combinator", "inserter"]) {
		assert.ok(handlerKeys.includes(known), `handler key '${known}' must be parsed`);
	}
	for (const known of ["locomotive", "storage-tank", "ammo-turret"]) {
		assert.ok(typeToCategory.has(known), `mapping row '${known}' must be parsed`);
	}
	assert.equal(new Set(handlerKeys).size, handlerKeys.length,
		"handler keys must be parsed without duplicates");
});

test("every export handler is reachable: some entity type dispatches to it", () => {
	const unreachable = handlerKeys.filter(key => !reachableCategories.has(key));
	assert.deepEqual(unreachable, [],
		`these handlers can never run — no entity type maps to them: ${unreachable.join(", ")}`);
});

test("artillery-turret dispatches to its own handler, not to the turret handler", () => {
	assert.equal(categoryOf("artillery-turret"), "artillery-turret",
		"artillery-turret must reach EntityHandlers['artillery-turret'] "
		+ "(mapping it to 'turret' strands artillery_auto_targeting out of the payload)");
	assert.ok(handlerKeys.includes("artillery-turret"),
		"the artillery-turret handler must exist for the mapping to reach");
});

test("every mapping row names an entity type that exists at the pin", () => {
	const pinned = new Set(ENTITY_TYPES_AT_PIN_2_1_11);
	const unknown = [...typeToCategory.keys()].filter(entityType => !pinned.has(entityType));
	assert.deepEqual(unknown, [],
		`these mapping rows name no entity type at the pin: ${unknown.join(", ")}`);
});

test("category dispatch does not string-search the entity type", () => {
	const start = gameUtilsSource.indexOf("function GameUtils.get_entity_category(entity)");
	assert.notEqual(start, -1, "get_entity_category must exist");
	const body = gameUtilsSource.slice(start, gameUtilsSource.indexOf("\nend", start));
	assert.doesNotMatch(body, /:find\(|:match\(|string\.(?:find|match)/,
		"dispatch must be an explicit table lookup — substring routing silently strands handlers "
		+ "whose type name contains another category's name");
});

test("belt classification survives the mapping", () => {
	const beltCategories = ["transport-belt", "underground-belt", "splitter", "loader", "loader-1x1"];
	for (const beltType of ["transport-belt", "underground-belt", "splitter", "loader", "loader-1x1",
		"lane-splitter"]) {
		assert.ok(beltCategories.includes(categoryOf(beltType)),
			`${beltType} must still classify as a belt category (export-pipeline keys belt handling `
			+ `off GameUtils.BELT_ENTITY_TYPES[category])`);
	}
});
