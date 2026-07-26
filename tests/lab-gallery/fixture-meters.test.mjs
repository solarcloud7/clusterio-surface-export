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

// (The "carries every corpus measurement and the fail-loud gate" test is GONE with its subject:
// measure_corpus and corpus_gate were defined, exported, and called by NOTHING — the test asserted
// the SOURCE TEXT of dead code existed, which is exactly the pin-the-wrong-thing shape the one-truth
// ruling names. What was still true of live code survives below.)

test("the fingerprint tolerance policy is scoped, never blanket", () => {
	// compare_fingerprint (run-tests.lua) still rides these: ONLY the crafting/bonus progress doubles
	// absorb the 1e-9 save/load ULP window; every other field compares exactly.
	assert.match(source, /local tolerant_double_fields = \{ progress = true, bonusProgress = true \}/);
	assert.match(source, /function approx_equal/);
	assert.match(source, /1e-9/);
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

// (runtime-driver test removed 2026-07-19 with the bake pipeline — the driver is deleted.)
