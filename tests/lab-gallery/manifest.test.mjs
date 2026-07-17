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
		labs: actualLabs.length, fixtures: 2, sourceFixtures: 2, destinationFixtures: 0,
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
		labs: 12, fixtures: 2, sourceFixtures: 2, destinationFixtures: 0,
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
	const reachability = manifest.fixtures.find(fixture => fixture.id === "specialized-fluid-reachability");
	assert.deepEqual(reachability, {
		id: "specialized-fluid-reachability",
		revision: 1,
		labId: "specialized-inventory-lab",
		name: "Specialized fluid reachability",
		purpose: "Recertify platform-reachable specialized fluid state from prototype and live entity controls.",
		category: "physical-lab",
		owningRunner: "tests/specialized-inventory-lab/run-reachability.mjs",
		saveRole: "source",
		platformName: "lab-specialized-fluid-r1",
		engineVersion: "2.0.77",
		mods: manifest.mods,
		invariant: "Space-platform pressure/gravity are zero and the baked electric mining drill has no live recoverable fluidbox.",
		expectedTerminalVerdict: "observation-only",
		independentOracleRequired: true,
		fingerprint: {
			pressure: 0, gravity: 0, drillName: "electric-mining-drill", miningTarget: null,
			liveFluidboxCount: 0, readOk: false, writeOk: false,
		},
	});
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
