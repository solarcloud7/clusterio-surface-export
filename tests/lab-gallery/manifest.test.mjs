import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { loadGalleryManifest, validateGalleryManifest } from "./manifest.mjs";

const repoRoot = new URL("../../", import.meta.url);

test("gallery manifest inventories every lab family exactly once", () => {
	const manifest = loadGalleryManifest(repoRoot);
	const actualLabs = readdirSync(new URL("../", import.meta.url), { withFileTypes: true })
		.filter(entry => entry.isDirectory() && entry.name.endsWith("-lab"))
		.map(entry => entry.name)
		.sort();
	assert.deepEqual(manifest.labs.map(lab => lab.id).sort(), actualLabs);
	assert.deepEqual(validateGalleryManifest(manifest, { requireArtifacts: false }), {
		labs: actualLabs.length, fixtures: 20, sourceFixtures: 20, destinationFixtures: 0,
	});
});

test("paired save roles, artifacts, censuses, and exact mod pins are final", () => {
	const manifest = loadGalleryManifest(repoRoot);
	assert.equal(manifest.schema, "surface-export-lab-gallery-v2");
	assert.equal(manifest.engineVersion, "2.0.77");
	assert.deepEqual(Object.keys(manifest.saves).sort(), ["destination", "source"]);
	for (const [role, save] of Object.entries(manifest.saves)) {
		assert.equal(save.role, role);
		assert.match(save.name, /^lab-gallery-[a-z0-9-]+$/, "server save names must not contain extension-like dots");
		assert.match(save.artifact, /^docker\/seed-data\/lab-saves\/.+\.zip$/);
		assert.match(save.sha256, /^[A-F0-9]{64}$/);
		assert.ok(save.expectedCensus.totalEntities >= 0);
		assert.ok(save.expectedCensus.totalGeneratedChunks >= 0);
		assert.ok(Array.isArray(save.expectedCensus.surfaces));
	}
	assert.equal(manifest.mods.base, "2.0.77");
	assert.equal(manifest.mods["space-age"], "2.0.77");
	assert.deepEqual(manifest.saves.source.mods, manifest.mods);
	assert.deepEqual(manifest.saves.destination.mods, manifest.mods);
	assert.deepEqual(validateGalleryManifest(manifest), {
		labs: 13, fixtures: 20, sourceFixtures: 20, destinationFixtures: 0,
	});
});

test("committed paired artifacts match their manifest hashes", () => {
	const manifest = loadGalleryManifest(repoRoot);
	for (const save of Object.values(manifest.saves)) {
		const actual = createHash("sha256").update(readFileSync(new URL(save.artifact, repoRoot))).digest("hex").toUpperCase();
		assert.equal(actual, save.sha256, save.artifact);
	}
});

test("baked fixtures remain inputs while direct physical meters remain the oracle", () => {
	const manifest = loadGalleryManifest(repoRoot);
	assert.equal(manifest.contract.fixtureIsOracle, false);
	assert.equal(manifest.contract.mutableDestinationsAreBaked, true);
	assert.match(manifest.contract.independentOracle, /direct.*Factorio/i);
	assert.match(manifest.contract.resetModel, /paired/i);
	const belt = manifest.fixtures.find(fixture => fixture.id === "belt-5x5-125-unstacked");
	assert.equal(belt.labId, "belt-lab");
	assert.equal(belt.saveRole, "source");
	assert.equal(belt.revision, 1);
	assert.equal(belt.independentOracleRequired, true);
	// The reachability fixture advanced to revision 2 (drill recreated, all entities destructible=false).
	const reachability = manifest.fixtures.find(fixture => fixture.id === "specialized-fluid-reachability");
	assert.equal(reachability.revision, 2);
	assert.equal(reachability.labId, "specialized-inventory-lab");
	assert.match(reachability.invariant, /destructible=false/);
	assert.deepEqual(reachability.fingerprint, {
		pressure: 0, gravity: 0, drillName: "electric-mining-drill", miningTarget: null,
		liveFluidboxCount: 0, readOk: false, writeOk: false,
	});
});

test("the sixteen-family corpus is inventoried with independent oracles and stable fingerprints", () => {
	const manifest = loadGalleryManifest(repoRoot);
	const byId = Object.fromEntries(manifest.fixtures.map(fixture => [fixture.id, fixture]));

	// Every omnibus family shares the one platform, carries an independent oracle, and a fingerprint.
	const omnibus = manifest.fixtures.filter(fixture => fixture.id.startsWith("omnibus-"));
	assert.equal(omnibus.length, 12);
	for (const fixture of omnibus) {
		assert.equal(fixture.platformName, "lab-omnibus-state-v1");
		assert.equal(fixture.independentOracleRequired, true);
		assert.ok(fixture.fingerprint && typeof fixture.fingerprint === "object");
	}

	// Exact frozen-state fingerprints (measured live 2026-07-17).
	assert.equal(byId["omnibus-heat-temperature"].fingerprint.temperature, 500);
	assert.equal(byId["omnibus-burner-fuel"].fingerprint.remaining, 2000000);
	assert.equal(byId["omnibus-midcraft-progress"].fingerprint.progress, 0.7000000000000005);
	assert.equal(byId["omnibus-adversarial-inventory"].fingerprint.battQuality, "legendary");
	assert.equal(byId["omnibus-crafting-fluids"].fingerprint.foundryTemp, 1500);
	assert.equal(byId["omnibus-platform-schedule"].fingerprint.interruptName, "lab-interrupt");
	assert.equal(byId["energy-accumulator-drain"].fingerprint.electricEntities, 1);
	assert.equal(byId["belt-corner-recovery"].fingerprint.cornerShape, "left");
	assert.equal(byId["belt-corner-recovery"].fingerprint.insideLength, 0.4140625);

	// The workhorse is structure-only: entity count fixed, item counts never fingerprinted (live drift).
	assert.deepEqual(byId["transfer-workhorse"].fingerprint, { entities: 1359 });
	assert.match(byId["transfer-workhorse"].note, /drift/i);

	// Consumables are bare single-use hubs; they explicitly opt out of an owning runner (null +
	// waiver reason), never by silently omitting the key.
	for (const n of [1, 2, 3]) {
		assert.deepEqual(byId[`consumable-hub-${n}`].fingerprint, { entities: 1 });
		assert.equal(byId[`consumable-hub-${n}`].owningRunner, null);
		assert.match(byId[`consumable-hub-${n}`].owningRunnerWaiver, /\S/);
	}

	// Layout blueprints are captured for the three requested layouts.
	for (const [id, prefix] of [["omnibus-adversarial-inventory", "0eNq"], ["energy-accumulator-drain", "0eNq"], ["belt-corner-recovery", "0eNq"]]) {
		assert.ok(byId[id].layoutBlueprint.startsWith(prefix), `${id} layoutBlueprint`);
	}
});

test("owningRunner is a required provenance key with an explicit, reasoned opt-out", () => {
	const manifest = loadGalleryManifest(repoRoot);
	const clone = () => JSON.parse(JSON.stringify(manifest));
	const withRunner = manifest.fixtures.find(fixture => typeof fixture.owningRunner === "string");
	assert.ok(withRunner, "expected at least one fixture with a real owning runner");

	// Red tooth: omitting the key entirely is a validation error (a real runner cannot be dropped silently).
	const dropped = clone();
	delete dropped.fixtures.find(fixture => fixture.id === withRunner.id).owningRunner;
	assert.throws(() => validateGalleryManifest(dropped, { requireArtifacts: false }), /missing owningRunner/);

	// Red tooth: a null opt-out without a waiver reason is rejected.
	const unreasoned = clone();
	const consumable = unreasoned.fixtures.find(fixture => fixture.id === "consumable-hub-1");
	delete consumable.owningRunnerWaiver;
	assert.throws(() => validateGalleryManifest(unreasoned, { requireArtifacts: false }), /owningRunnerWaiver/);

	// The reasoned null opt-out (as shipped) validates.
	assert.doesNotThrow(() => validateGalleryManifest(clone(), { requireArtifacts: false }));
});

test("visual zones have stable unique coordinates and durable source paths", () => {
	const manifest = loadGalleryManifest(repoRoot);
	const positions = new Set();
	for (const lab of manifest.labs) {
		assert.equal(lab.sourcePath, `tests/${lab.id}`);
		assert.match(lab.title, /\S/);
		assert.match(lab.purpose, /\S/);
		assert.ok(Number.isInteger(lab.zone.x));
		assert.ok(Number.isInteger(lab.zone.y));
		const key = `${lab.zone.x},${lab.zone.y}`;
		assert.equal(positions.has(key), false, `duplicate zone ${key}`);
		positions.add(key);
	}
});
