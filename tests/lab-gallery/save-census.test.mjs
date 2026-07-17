import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { assertCensusShape, parseArguments } from "./save-census.mjs";

test("save census requires one artifact and an isolated Factorio host container", () => {
	assert.deepEqual(parseArguments(["--save", "gallery.zip"]), {
		save: "gallery.zip", container: "surface-export-host-2",
	});
	assert.throws(() => parseArguments([]), /--save/);
	assert.throws(() => parseArguments(["--save", "gallery.zip", "--container", "unrelated"]), /container/);
});

test("save census shape exposes structural world cost and safety state", () => {
	const reading = {
		version: "2.0.77", mods: { base: "2.0.77", "space-age": "2.0.77" }, game_paused: false,
		transient: { jobs: 0, locks: 0, holds: 0, tombstones: 0 },
		surfaces: [{ name: "nauvis", entity_count: 1, generated_chunks: 1, platform: null, planet: "nauvis" }],
		platforms: [], total_entities: 1, total_generated_chunks: 1,
	};
	assert.deepEqual(assertCensusShape(reading), reading);
	const emptyLuaArray = { ...structuredClone(reading), platforms: {} };
	assert.deepEqual(assertCensusShape(emptyLuaArray).platforms, []);
	for (const patch of [
		{ version: null }, { mods: null }, { game_paused: null }, { transient: null },
		{ surfaces: null }, { platforms: null }, { total_entities: -1 }, { total_generated_chunks: -1 },
	]) assert.throws(() => assertCensusShape({ ...reading, ...patch }));
});

test("save census is read-only, time-bounded, and cleans its isolated process root", () => {
	const source = readFileSync(new URL("./save-census.mjs", import.meta.url), "utf8");
	assert.match(source, /timeout/);
	assert.match(source, /finally/);
	assert.match(source, /surface-export-lab-gallery-census/);
	assert.match(source, /save-census-meter\.cjs/);
	assert.doesNotMatch(source, /send-rcon|clusterioctl|game\.delete_surface|game\.tick_paused\s*=/);
});
