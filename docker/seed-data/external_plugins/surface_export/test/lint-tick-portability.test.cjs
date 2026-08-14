"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const fs = require("node:fs");

const scriptUrl = pathToFileURL(path.join(__dirname, "..", "scripts", "lint-tick-portability.mjs")).href;
const indexPath = path.join(__dirname, "..", "scripts", "factorio-api-index.json");

async function guard() {
	return import(scriptUrl);
}

test("the doc-derived absolute-tick list is non-empty and carries the known hazards", async () => {
	const { absoluteTickAttributes } = await guard();
	const names = absoluteTickAttributes(JSON.parse(fs.readFileSync(indexPath, "utf8")));
	assert.ok(names.includes("tick_grown"),
		"tick_grown must derive as absolute — its doc reads 'The tick when this plant is fully grown'");
	assert.ok(names.includes("spoil_tick"),
		"spoil_tick must derive as absolute — its doc reads 'The tick this item spoils'");
	assert.ok(names.length >= 2 && names.length <= 40,
		`derived list has ${names.length} names — outside sanity bounds, the doc regex drifted`);
	assert.ok(!names.includes("jump_delay_ticks"),
		"jump_delay_ticks is 'The tick delay between each jump' — a DURATION; deriving it as absolute "
		+ "means the doc regex loosened and the guard now cries wolf on lawful duration reads");
});

test("a raw read of an absolute-tick attribute fires; same-line clock arithmetic passes", async () => {
	const { findTickViolations } = await guard();
	const names = ["tick_grown", "spoil_tick"];
	assert.equal(findTickViolations("local t = entity.tick_grown\n", "f.lua", names).length, 1);
	assert.equal(findTickViolations("local rem = entity.tick_grown - game.tick\n", "f.lua", names).length, 0);
	assert.equal(
		findTickViolations("entity.tick_grown = game.tick + data.grown_ticks_remaining\n", "f.lua", names).length,
		0);
});

test("a raw write without the destination clock fires", async () => {
	const { findTickViolations } = await guard();
	assert.equal(
		findTickViolations("entity.tick_grown = data.tick_grown\n", "f.lua", ["tick_grown"]).length, 1);
});

test("the allow marker silences, same line or the line above", async () => {
	const { findTickViolations } = await guard();
	const names = ["spoil_tick"];
	assert.equal(findTickViolations("local t = stack.spoil_tick -- tick:allow\n", "f.lua", names).length, 0);
	assert.equal(findTickViolations("-- tick:allow\nlocal t = stack.spoil_tick\n", "f.lua", names).length, 0);
});

test("duration-named fields and unrelated identifiers do not fire", async () => {
	const { findTickViolations } = await guard();
	const names = ["tick_grown", "spoil_tick"];
	assert.equal(findTickViolations("local d = payload.grown_ticks_remaining\n", "f.lua", names).length, 0);
	assert.equal(findTickViolations("local g = prototype.growth_ticks\n", "f.lua", names).length, 0);
});
