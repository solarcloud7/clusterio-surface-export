import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The shared measurement library lives in the module tree (single source consumed by the save-patched
// module AND the plugin-less isolated bake). It is read from there so this test guards the real file.
const source = readFileSync(
	new URL("../../docker/seed-data/external_plugins/surface_export/module/utils/fixture-meters.lua", import.meta.url),
	"utf8",
);

test("fixture-meters is injection-safe: no require, no long-string delimiter, single M table", () => {
	// Dual-injection contract: pure Factorio-API Lua so it loads under BOTH require(...) (save-patched
	// module) and (function() <text> end)() inline injection (headless /c). A require would break the
	// no-plugin bake; a ]=] would corrupt the Lua long-string RCON wrapper some callers ship it inside.
	// Strip Lua line comments so the doc header (which describes the require path in prose) is not
	// mistaken for an executable require — it is the require STATEMENT that would break the bake.
	const code = source.replace(/--.*$/gm, "");
	assert.doesNotMatch(code, /\brequire\s*\(/);
	assert.ok(!source.includes("]=]"), "fixture-meters.lua must not contain the ]=] long-string delimiter");
	assert.match(source, /^local M = \{\}/m);
	assert.match(source, /\nreturn M\s*$/);
});

test("fixture-meters carries every corpus measurement and the fail-loud gate", () => {
	assert.match(source, /function measure_corpus/);
	assert.match(source, /function corpus_gate/);
	assert.match(source, /fixture\.fingerprint/);
	// A missing read fails approx_equal, so a dropped field cannot pass the gate; the 1e-9 tolerance
	// is scoped to the progress doubles only, never applied blanket.
	assert.match(source, /approx_equal/);
	assert.match(source, /tolerant_double_fields/);
	// Exclusions are an explicit allowlist, not an absence-skip; the fixture tally is reported for the
	// build-side count pin.
	assert.match(source, /corpus_excluded/);
	assert.match(source, /expectedFixtures/);
	// Unsatisfiable by omission: a missing measurement / measurement error fails the gate loudly.
	assert.match(source, /was not measured/);
	assert.match(source, /measurement error/);
	// Physical locators + reads for the family platforms.
	for (const platform of ["lab-omnibus-state-v1", "lab-energy-v1", "lab-belt-corner-v1", "lab-transfer-fixture-v1", "lab-consumable-", "lab-census-fusion-v1"]) {
		assert.match(source, new RegExp(platform));
	}
	assert.match(source, /crafting_progress/);
	assert.match(source, /get_circuit_network/);
	assert.match(source, /get_detailed_contents/);
	assert.match(source, /unique_id/);
});

test("fixture-meters additive refactors preserve default behavior", () => {
	// anchor_lookup gains an optional dx (default 0) — a.x + dx with dx=0 is byte-identical.
	assert.match(source, /function anchor_lookup\(manifest, fixture_id, dx\)/);
	assert.match(source, /dx = dx or 0/);
	assert.match(source, /a\.x \+ dx/);
	// Whole-surface scans gain an optional area (nil = whole surface) so a pasted right half is not
	// double-counted; a nil area field is identical to an omitted key.
	assert.match(source, /function measure_omnibus_ghosts\(surface, area\)/);
	assert.match(source, /function measure_omnibus_ground\(surface, area\)/);
	assert.match(source, /type = "entity-ghost", area = area/);
	assert.match(source, /type = "item-entity", area = area/);
});

test("the spoil probe pcall is annotated so lint:pcall-logging accepts it", () => {
	// Moving into module/ subjects this file to lint:pcall-logging; the spoil_percent probe is an
	// intentional per-stack existence probe (nil is a valid reading), annotated within +/-2 lines.
	assert.match(source, /intentional probe;[^\n]*spoil_percent/);
});

test("runtime-driver ships the meters prelude, strips CRLF, and guards the delimiter on every file", () => {
	const driver = readFileSync(new URL("./runtime-driver.cjs", import.meta.url), "utf8");
	assert.ok(driver.includes("replace(/\\r/g"), "runtime-driver must strip \\r from every shipped Lua file");
	assert.match(driver, /unsafe long-string delimiter/);
	// Preludes are injected ahead of the runtime as the FixtureMeters library.
	assert.match(driver, /local FixtureMeters=\(function\(\)/);
});
