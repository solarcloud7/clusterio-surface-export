"use strict";
const test = require("node:test");
const assert = require("node:assert");

const { selectPlanetNames } = require("../dist/node/shared/planets.js");

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
	assert.ok(names.includes("maraxsis"), "maraxsis (modded) must be offered");
	assert.ok(names.includes("maraxsis-trench"), "maraxsis-trench (modded) must be offered");
});

test("surfaceless space-locations are NOT offered as destinations", () => {
	const names = selectPlanetNames([SPACE_LOCATION_BUCKET]);
	for (const notAPlanet of [
		"surfexp_gateway_1", "surfexp_gateway_2", "surfexp_gateway_3", "surfexp_gateway_4",
		"solar-system-edge", "shattered-planet", "space-location-unknown",
	]) {
		assert.ok(!names.includes(notAPlanet), `${notAPlanet} must never be offered as a destination`);
	}
});

test("a bucket literally named 'planet' also works, if Clusterio ever adds one", () => {
	const names = selectPlanetNames([[{ name: "nauvis", type: "planet" }]]);
	assert.deepEqual(names, ["nauvis"]);
});

test("an empty or absent metadata set yields no options rather than throwing", () => {
	assert.deepEqual(selectPlanetNames([]), []);
	assert.deepEqual(selectPlanetNames([[]]), []);
});
