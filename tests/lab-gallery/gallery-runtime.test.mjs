import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./gallery-runtime.lua", import.meta.url), "utf8");

test("gallery runtime is prefix-owned, version-pinned, and never changes pause ownership", () => {
	assert.match(source, /lab-gallery-/);
	assert.match(source, /2\.0\.77/);
	assert.doesNotMatch(source, /game\.tick_paused\s*=/);
	assert.doesNotMatch(source, /clone|spill_item_stack|remote\.call/);
});

test("gallery runtime exposes bounded paired-build and inspection operations", () => {
	for (const operation of ["preflight", "normalize_source", "inspect", "prepare_destination", "save"]) {
		assert.match(source, new RegExp(`operation == [\"']${operation}[\"']`));
	}
	for (const state of ["gamePaused", "jobs", "locks", "holds", "tombstones"]) assert.match(source, new RegExp(state));
	assert.match(source, /game\.server_save/);
	assert.match(source, /game\.delete_surface/);
});

test("normalization verifies the hand-curated corpus and never constructs or minimizes it", () => {
	// Verify-not-construct: the corpus is hand-built in the seed. Normalize must not create,
	// destroy, or minimize any platform surface.
	assert.doesNotMatch(source, /create_space_platform/);
	assert.doesNotMatch(source, /apply_starter_pack/);
	assert.doesNotMatch(source, /minimize_nauvis/);
	assert.doesNotMatch(source, /delete_chunk/);
	// Normalize rebuilds only the index catalog and applies lab-safe settings, then physically
	// verifies every fingerprint against the manifest before it will accept the source.
	assert.match(source, /default_enable_all_autoplace_controls\s*=\s*false/);
	assert.match(source, /reading\.corpusExact/);
	assert.match(source, /specialized-fluid-reachability/);
	// Only prepare_destination tears the roster down (ticked destroy of ALL platforms).
	assert.match(source, /destroy_all_platforms/);
	assert.match(source, /platform\.destroy\(0\)/);
	assert.match(source, /prepare_destination/);
});

test("the corpus is measured and gated through the shared FixtureMeters library", () => {
	// The measurement bodies live in module/utils/fixture-meters.lua (single source); gallery-runtime
	// only orchestrates, calling the injected FixtureMeters prelude — so the meter internals are
	// asserted in fixture-meters.test.mjs, not re-inlined here.
	assert.match(source, /FixtureMeters\.measure_corpus\(manifest\)/);
	assert.match(source, /FixtureMeters\.corpus_gate\(manifest, measured\)/);
	assert.match(source, /reading\.corpusExact = reading\.corpusGate\.exact/);
	// The meter bodies must NOT be re-inlined here (net-negative extraction; no drift risk).
	assert.doesNotMatch(source, /local function measure_corpus/);
	assert.doesNotMatch(source, /local function measure_omnibus/);
	assert.doesNotMatch(source, /local function corpus_gate/);
});

test("normalization applies lab settings to non-platform surfaces via the real write APIs", () => {
	assert.match(source, /for _, surface in pairs\(game\.surfaces\)/);
	assert.match(source, /surface\.generate_with_lab_tiles\s*=\s*true/);
	// has_global_electric_network is READ-ONLY at 2.0.77; the write path is the method.
	assert.doesNotMatch(source, /surface\.has_global_electric_network\s*=[^=]/);
	assert.match(source, /create_global_electric_network\(\)/);
	assert.match(source, /surface\.ignore_surface_conditions\s*=\s*true/);
	// Platform surfaces are measured fixtures: never mutated, values recorded as measured.
	assert.match(source, /if surface\.platform == nil then/);
	// inspect() must read settings without writing them (the self-manufactured-PASS class).
	assert.match(source, /surfaceSettings = read_lab_surface_settings\(\)/);
});

test("visual catalog, belt pilot, and reachability fixture have independent physical readings", () => {
	assert.match(source, /rendering\.draw_text/);
	assert.match(source, /add_chart_tag/);
	// Belt-pilot quantities are read through the shared library (get_detailed_contents/unique_id live
	// in fixture-meters.lua now); the exact-match assertions against the pilot expectations stay here.
	assert.match(source, /FixtureMeters\.detailed_census/);
	assert.match(source, /maximumStack == expected\.maximumStack/);
	assert.match(source, /sourceQuantity == expected\.sourceQuantity/);
	assert.match(source, /targetQuantity == expected\.targetQuantity/);
	assert.match(source, /find_entity/);
	assert.match(source, /surface\.get_property\("pressure"\)/);
	assert.match(source, /surface\.get_property\("gravity"\)/);
	assert.match(source, /#drill\.fluidbox/);
	assert.match(source, /mining_target/);
	assert.doesNotMatch(source, /insert_at_back|insert_at\(/);
});
