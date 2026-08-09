import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
	new URL("../../docker/seed-data/external_plugins/surface_export/module/utils/fixture-meters.lua", import.meta.url),
	"utf8",
);

test("fixture-meters is injection-safe: no require, no long-string delimiter, single M table", () => {
	const code = source.replace(/--.*$/gm, "");
	assert.doesNotMatch(code, /\brequire\s*\(/);
	assert.ok(!source.includes("]=]"), "fixture-meters.lua must not contain the ]=] long-string delimiter");
	assert.match(source, /^local M = \{\}/m);
	assert.match(source, /\nreturn M\s*$/);
});


test("the fingerprint tolerance policy is scoped, never blanket", () => {
	assert.match(source, /local tolerant_double_fields = \{ progress = true, bonusProgress = true \}/);
	assert.match(source, /function approx_equal/);
	assert.match(source, /1e-9/);
});

test("fixture-meters additive refactors preserve default behavior", () => {
	assert.match(source, /function anchor_lookup\(manifest, fixture_id, dx\)/);
	assert.match(source, /dx = dx or 0/);
	assert.match(source, /a\.x \+ dx/);
	assert.match(source, /function measure_omnibus_ghosts\(surface, area\)/);
	assert.match(source, /function measure_omnibus_ground\(surface, area\)/);
	assert.match(source, /type = "entity-ghost", area = area/);
	assert.match(source, /type = "item-entity", area = area/);
});

test("the spoil probe pcall is annotated so lint:pcall-logging accepts it", () => {
	assert.match(source, /intentional probe;[^\n]*spoil_percent/);
});

