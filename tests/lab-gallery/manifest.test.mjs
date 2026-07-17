import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
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
	assert.deepEqual(validateGalleryManifest(manifest), { labs: actualLabs.length, bakedSources: 1 });
});

test("baked fixtures remain inputs while independent meters remain the oracle", () => {
	const manifest = loadGalleryManifest(repoRoot);
	assert.equal(manifest.engineVersion, "2.0.77");
	assert.match(manifest.saveName, /^lab-gallery-[a-z0-9-]+$/, "server save names must not contain extension-like dots");
	assert.equal(manifest.contract.fixtureIsOracle, false);
	assert.equal(manifest.contract.mutableDestinationsAreBaked, false);
	assert.match(manifest.contract.independentOracle, /runner/i);
	const pilot = manifest.labs.find(lab => lab.mode === "baked-source");
	assert.equal(pilot.id, "belt-lab");
	assert.equal(pilot.fixture, "belt-5x5-125-unstacked");
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
