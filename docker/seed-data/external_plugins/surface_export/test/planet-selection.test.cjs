"use strict";
const test = require("node:test");
const assert = require("node:assert");

const { selectPlanetNames } = require("../dist/node/shared/planets.js");

/**
 * The REAL bucket contents, read from the live spritesheet metadata on 2026-08-04
 * (http://localhost:8080/static/metadata.<hash>.json, Space Age 2.0 pack + maraxsis + PlanetsLib).
 *
 * Production-shaped on purpose: the defect this pins shipped precisely because the shape was
 * assumed rather than read. Every planet is filed under the `space-location` bucket next to entries
 * that are not planets, and there is no `planet` bucket at all.
 */
const SPACE_LOCATION_BUCKET = [
	{ name: "space-location-unknown", type: "space-location" },
	{ name: "solar-system-edge", type: "space-location" },
	{ name: "shattered-planet", type: "space-location" },
	{ name: "surfexp_gateway_1", type: "space-location" },
	{ name: "surfexp_gateway_2", type: "space-location" },
	{ name: "surfexp_gateway_3", type: "space-location" },
	{ name: "surfexp_gateway_4", type: "space-location" },
	{ name: "nauvis", type: "planet" },
	{ name: "vulcanus", type: "planet" },
	{ name: "gleba", type: "planet" },
	{ name: "fulgora", type: "planet" },
	{ name: "aquilo", type: "planet" },
	{ name: "maraxsis", type: "planet" },
	{ name: "maraxsis-trench", type: "planet" },
];

const ITEM_BUCKET = [
	{ name: "iron-plate", type: "item" },
	{ name: "space-platform-starter-pack", type: "item" },
];

test("planets are selected by entry type, out of a bucket that is not named for them", () => {
	const names = selectPlanetNames([SPACE_LOCATION_BUCKET, ITEM_BUCKET]);
	assert.deepEqual(names, [
		"aquilo", "fulgora", "gleba", "maraxsis", "maraxsis-trench", "nauvis", "vulcanus",
	]);
});

test("modded planets are included — the whole point of reading metadata instead of a literal list", () => {
	const names = selectPlanetNames([SPACE_LOCATION_BUCKET]);
	// The list this replaced was hardcoded to the five vanilla planets, so these two were missing.
	assert.ok(names.includes("maraxsis"), "maraxsis (modded) must be offered");
	assert.ok(names.includes("maraxsis-trench"), "maraxsis-trench (modded) must be offered");
});

test("surfaceless space-locations are NOT offered as destinations", () => {
	const names = selectPlanetNames([SPACE_LOCATION_BUCKET]);
	// create_space_platform{ planet = ... } cannot create a platform at these, so offering one is a
	// guaranteed Lua-side failure rather than a cosmetic slip.
	for (const notAPlanet of [
		"surfexp_gateway_1", "surfexp_gateway_2", "surfexp_gateway_3", "surfexp_gateway_4",
		"solar-system-edge", "shattered-planet", "space-location-unknown",
	]) {
		assert.ok(!names.includes(notAPlanet), `${notAPlanet} must never be offered as a destination`);
	}
});

test("a bucket literally named 'planet' also works, if Clusterio ever adds one", () => {
	// Guards the forward-compatibility claim in selectPlanetNames: it scans all buckets rather than
	// looking one up by name, so a re-bucketing upstream does not empty the dropdown.
	const names = selectPlanetNames([[{ name: "nauvis", type: "planet" }]]);
	assert.deepEqual(names, ["nauvis"]);
});

test("an empty or absent metadata set yields no options rather than throwing", () => {
	assert.deepEqual(selectPlanetNames([]), []);
	assert.deepEqual(selectPlanetNames([[]]), []);
});
