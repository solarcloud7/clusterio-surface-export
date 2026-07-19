import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadGalleryManifest } from "./manifest.mjs";
import { assertCorpus, assertReloadReading, assertSurfaceSettings, buildExpectations, parseArguments } from "./verify-save.mjs";

const repoRoot = new URL("../../", import.meta.url);
const manifest = loadGalleryManifest(repoRoot);
const expectations = buildExpectations(manifest);
const source = readFileSync(new URL("./verify-save.mjs", import.meta.url), "utf8");

const surfaceSettings = expectations.source.census.surface_names.map(name => ({
	name, generate_with_lab_tiles: true, has_global_electric_network: true, ignore_surface_conditions: true,
}));

function sourceReading() {
	return {
		version: "2.0.77", save_role: "source", gallery_storage: true, index_surface: true,
		game_paused: false, transient: { jobs: 0, locks: 0, holds: 0, tombstones: 0 },
		// Belt values are taken from the manifest-derived expectations so this mock never drifts from a
		// re-pinned loop fingerprint (the loop is one pad now — target_belts/target_quantity are zero).
		...expectations.source.belt,
		index_texts: expectations.source.labCount, index_tags: expectations.source.labCount,
		reachability: { exists: true, platform_name: "lab-specialized-fluid-r1", drill_name: "electric-mining-drill", pressure: 0, gravity: 0, mining_target: false, live_fluidbox_count: 0, read_ok: false, write_ok: false },
		surface_settings: surfaceSettings,
		surface_census: expectations.source.census,
		corpus: structuredClone(expectations.source.corpus),
	};
}

test("paired reload verifier requires both artifacts and an isolated host", () => {
	assert.deepEqual(parseArguments(["--source-save", "source.zip", "--destination-save", "destination.zip"]), {
		sourceSave: "source.zip", destinationSave: "destination.zip", container: "surface-export-host-2",
	});
	assert.throws(() => parseArguments(["--source-save", "source.zip"]), /destination-save/);
	assert.throws(() => parseArguments(["--destination-save", "destination.zip"]), /source-save/);
});

test("buildExpectations measures every source platform fixture and clears the destination", () => {
	const measured = Object.keys(expectations.source.corpus).sort();
	// The belt pilot and the reachability drill are asserted separately, not in the corpus.
	assert.ok(!measured.includes("belt-5x5-125-unstacked"));
	assert.ok(!measured.includes("specialized-fluid-reachability"));
	assert.ok(measured.includes("omnibus-midcraft-progress"));
	assert.ok(measured.includes("transfer-workhorse"));
	assert.equal(measured.length, manifest.fixtures.filter(f => f.saveRole === "source").length - 2);
	assert.deepEqual(expectations.destination.corpus, {});
});

test("source acceptance includes belt pilot, reachability, and the full physical corpus", () => {
	const reading = sourceReading();
	assert.equal(assertReloadReading(reading, "source", expectations.source), reading);
	assert.throws(() => assertReloadReading({ ...sourceReading(), source_quantity: 124 }, "source", expectations.source), /source_quantity/);
	assert.throws(() => assertReloadReading({ ...sourceReading(), reachability: { ...sourceReading().reachability, read_ok: true } }, "source", expectations.source), /read_ok/);
	// Red tooth: a drifted corpus fingerprint fails.
	const drifted = sourceReading();
	drifted.corpus["omnibus-heat-temperature"] = { temperature: 490 };
	assert.throws(() => assertReloadReading(drifted, "source", expectations.source), /omnibus-heat-temperature\.temperature/);
	// Red tooth: a dropped corpus fixture fails.
	const dropped = sourceReading();
	delete dropped.corpus["omnibus-ground-items"];
	assert.throws(() => assertReloadReading(dropped, "source", expectations.source), /corpus fixture set/);
	// Red tooth (self-manufactured-PASS class): a dropped meter field on the reachability drill fails
	// loudly instead of being normalized to a passing value. mining_target is emitted as an explicit
	// `false`, so an absent field is a bug the gate rejects.
	const droppedField = sourceReading();
	delete droppedField.reachability.mining_target;
	assert.throws(() => assertReloadReading(droppedField, "source", expectations.source), /mining_target/);
});

test("crafting-progress compares with a tolerance but rejects real drift", () => {
	const reading = sourceReading();
	const exact = expectations.source.corpus["omnibus-midcraft-progress"].progress;
	reading.corpus["omnibus-midcraft-progress"] = { progress: exact + 1e-12, active: false, inputPlates: 2 };
	assert.equal(assertReloadReading(reading, "source", expectations.source), reading);
	reading.corpus["omnibus-midcraft-progress"] = { progress: exact + 0.01, active: false, inputPlates: 2 };
	assert.throws(() => assertReloadReading(reading, "source", expectations.source), /midcraft-progress\.progress/);
});

test("destination acceptance proves the paired absence contract with an empty corpus", () => {
	const reading = {
		version: "2.0.77", save_role: "destination", gallery_storage: true, index_surface: true,
		game_paused: false, transient: { jobs: 0, locks: 0, holds: 0, tombstones: 0 },
		source_belts: 0, target_belts: 0, source_quantity: 0, physical_stacks: 0,
		maximum_stack: 0, source_line_quantities: [0, 0], target_quantity: 0,
		index_texts: expectations.destination.labCount, index_tags: expectations.destination.labCount, reachability: { exists: false },
		surface_settings: expectations.destination.census.surface_names.map(name => ({
			name, generate_with_lab_tiles: true, has_global_electric_network: true, ignore_surface_conditions: true,
		})),
		surface_census: expectations.destination.census, corpus: {},
	};
	assert.equal(assertReloadReading(reading, "destination", expectations.destination), reading);
	assert.throws(() => assertReloadReading({ ...reading, reachability: { exists: true } }, "destination", expectations.destination), /exists/);
	// Red tooth: a surviving platform fixture on the destination fails.
	assert.throws(() => assertReloadReading({ ...reading, corpus: { "consumable-hub-1": { entities: 1 } } }, "destination", expectations.destination), /corpus fixture set/);
});

test("assertCorpus rejects missing fixtures and drifted fields directly", () => {
	assert.throws(() => assertCorpus({}, { "energy-accumulator-drain": { accEnergy: 3000000 } }, "source"), /corpus fixture set/);
	assert.throws(() => assertCorpus({ "energy-accumulator-drain": { accEnergy: 2999999 } }, { "energy-accumulator-drain": { accEnergy: 3000000 } }, "source"), /accEnergy/);
	assert.deepEqual(assertCorpus({ x: { a: 1 } }, { x: { a: 1 } }, "source"), { x: { a: 1 } });
});

test("reload acceptance rejects any surface missing an editor lab setting", () => {
	const settings = surfaceSettings.slice(0, 2);
	assert.equal(assertSurfaceSettings(settings), settings);
	for (const field of ["generate_with_lab_tiles", "has_global_electric_network", "ignore_surface_conditions"]) {
		const changed = structuredClone(settings);
		changed[0][field] = false;
		assert.throws(() => assertSurfaceSettings(changed), new RegExp(field));
	}
});

test("isolated verifier reloads each save and always removes its runtime", () => {
	assert.match(source, /for \(const role of \["source", "destination"\]\)/);
	assert.match(source, /launchIsolatedFactorio/);
	assert.match(source, /finally/);
	assert.match(source, /surface-export-lab-gallery-verify/);
	assert.doesNotMatch(source, /clusterioctl|send-rcon|game\.tick_paused\s*=/);
});
