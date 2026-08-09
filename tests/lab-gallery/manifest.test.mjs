import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import test from "node:test";

import { loadGalleryManifest, renderExpectFromLifecycle, validateGalleryManifest } from "./manifest.mjs";

const repoRoot = new URL("../../", import.meta.url);

test("gallery manifest labs are the fixture-referenced categories (lab dirs removed 2026-07-19)", () => {
	const manifest = loadGalleryManifest(repoRoot);
	const referenced = [...new Set(manifest.fixtures.map(fixture => fixture.labId))].sort();
	assert.deepEqual(manifest.labs.map(lab => lab.id).sort(), referenced);
	assert.deepEqual(validateGalleryManifest(manifest, { requireArtifacts: false }), {
		labs: referenced.length, fixtures: manifest.fixtures.length,
		sourceFixtures: manifest.fixtures.length, destinationFixtures: 0,
	});
});

test("paired save roles, artifacts, censuses, and exact mod pins are final", () => {
	const manifest = loadGalleryManifest(repoRoot);
	assert.equal(manifest.schema, "surface-export-lab-gallery-v3");
	assert.equal(manifest.engineVersion, "2.1.11");
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
	assert.equal(manifest.mods.base, "2.1.11");
	assert.equal(manifest.mods["space-age"], "2.1.11");
	assert.deepEqual(manifest.saves.source.mods, manifest.mods);
	assert.deepEqual(manifest.saves.destination.mods, manifest.mods);
	assert.deepEqual(validateGalleryManifest(manifest), {
		labs: manifest.labs.length, fixtures: manifest.fixtures.length,
		sourceFixtures: manifest.fixtures.length, destinationFixtures: 0,
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
	const belt = manifest.fixtures.find(fixture => fixture.id === "belt-combined-omnibus");
	assert.equal(belt.labId, "belt-lab");
	assert.equal(belt.saveRole, "source");
	assert.equal(belt.independentOracleRequired, true);
	const miner = manifest.fixtures.find(fixture => fixture.id === "mining-drill-acid-feed");
	assert.equal(miner.labId, "specialized-inventory-lab");
	assert.equal(miner.padKind, "pad");
	assert.deepEqual(Object.keys(miner.fingerprint).sort(),
		["acidSegmentTotal", "drillHasAcid", "drillName", "groundItems", "resourceCount", "resourceTotal"]);
});

test("the corpus is inventoried with independent oracles and stable fingerprints", () => {
	const manifest = loadGalleryManifest(repoRoot);
	const byId = Object.fromEntries(manifest.fixtures.map(fixture => [fixture.id, fixture]));

	const omnibus = manifest.fixtures.filter(fixture => fixture.id.startsWith("omnibus-"));
	assert.ok(omnibus.length > 0, "omnibus family present");
	for (const fixture of omnibus) {
		assert.equal(fixture.platformName, "lab-omnibus-state-v1");
		assert.equal(fixture.independentOracleRequired, true);
		assert.ok(fixture.fingerprint && typeof fixture.fingerprint === "object");
	}

	assert.deepEqual(Object.keys(byId["transfer-workhorse"].fingerprint), ["entities"]);
	assert.equal(typeof byId["transfer-workhorse"].fingerprint.entities, "number");
	assert.match(byId["transfer-workhorse"].note, /drift/i);

	for (const [id, prefix] of [["omnibus-adversarial-inventory", "0eNq"]]) {
		assert.ok(byId[id].layoutBlueprint.startsWith(prefix), `${id} layoutBlueprint`);
	}
});

test("owningRunner is a required provenance key with an explicit, reasoned opt-out", () => {
	const manifest = loadGalleryManifest(repoRoot);
	const clone = () => JSON.parse(JSON.stringify(manifest));
	const withRunner = manifest.fixtures.find(fixture => typeof fixture.owningRunner === "string");
	assert.ok(withRunner, "expected at least one fixture with a real owning runner");

	const dropped = clone();
	delete dropped.fixtures.find(fixture => fixture.id === withRunner.id).owningRunner;
	assert.throws(() => validateGalleryManifest(dropped, { requireArtifacts: false }), /missing owningRunner/);

	const unreasoned = clone();
	const waived = unreasoned.fixtures.find(fixture => fixture.id === "inserter-held-capacity");
	delete waived.owningRunnerWaiver;
	assert.throws(() => validateGalleryManifest(unreasoned, { requireArtifacts: false }), /owningRunnerWaiver/);

	assert.doesNotThrow(() => validateGalleryManifest(clone(), { requireArtifacts: false }));
});

test("every string owningRunner points at a runner that actually exists", () => {
	const manifest = loadGalleryManifest(repoRoot);
	const dangling = manifest.fixtures
		.filter(fixture => typeof fixture.owningRunner === "string")
		.filter(fixture => !existsSync(new URL(fixture.owningRunner, repoRoot)))
		.map(fixture => `${fixture.id} -> ${fixture.owningRunner}`);
	assert.deepEqual(dangling, [], `dangling owningRunner(s): ${dangling.join("; ")}`);
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

test("lifecycle validation teeth: hook allowlist, grounding rule, mutable-anchor rule", () => {
	const manifest = loadGalleryManifest(repoRoot);
	const clone = () => JSON.parse(JSON.stringify(manifest));
	const withLifecycle = (lifecycle, anchors) => {
		const m = clone();
		const fx = m.fixtures.find(fixture => fixture.id === "belt-combined-omnibus");
		fx.lifecycle = lifecycle;
		if (anchors) fx.anchors = anchors;
		return m;
	};
	assert.throws(() => validateGalleryManifest(withLifecycle({
		version: 1, setup: [{ op: "arm_hook", name: "test_disable_gate", value: true }],
	}), { requireArtifacts: false }), /fail-safe allowlist/);
	assert.doesNotThrow(() => validateGalleryManifest(withLifecycle({
		version: 1, setup: [{ op: "arm_hook", name: "test_force_item_loss", value: 5 }],
	}), { requireArtifacts: false }));
	assert.throws(() => validateGalleryManifest(withLifecycle({
		version: 1,
		verify: [
			{ check: "fingerprint", enabled: false },
			{ check: "report_field", path: "validation.validation_success", op: "eq", expected: true },
		],
	}), { requireArtifacts: false }), /physical witness/);
	assert.throws(() => validateGalleryManifest(withLifecycle({
		version: 1, mutable: [],
		setup: [{ op: "spawn_item", name: "raw-fish", count: 10, into: "anchor:scratch-chest" }],
	}, [{ entity: "steel-chest", x: 1, y: 1, name: "scratch-chest" }]), { requireArtifacts: false }), /mutable anchor/);
	const ok = withLifecycle({
		version: 1, mutable: ["scratch-chest"],
		setup: [{ op: "spawn_item", name: "raw-fish", count: 10, spoil_percent: 0.5, into: "anchor:scratch-chest" }],
		act: "copy-paste",
		verify: [{ check: "physical_read", locator: { anchor: "scratch-chest" }, read: "item_count", item: "raw-fish", op: "eq", expected: 10 }],
	}, [{ entity: "steel-chest", x: 1, y: 1, name: "scratch-chest" }]);
	assert.doesNotThrow(() => validateGalleryManifest(ok, { requireArtifacts: false }));
	const lines = renderExpectFromLifecycle(ok.fixtures.find(fixture => fixture.id === "belt-combined-omnibus"));
	assert.ok(lines.some(line => /raw-fish item_count eq 10/.test(line)));

	const SUITE = "tests/integration/gallery-suite/run-tests.mjs";
	const withTransferLifecycle = (lifecycle) => {
		const m = clone();
		const fx = m.fixtures.find(fixture => fixture.id === "belt-combined-omnibus");
		fx.owningRunner = SUITE;
		delete fx.owningRunnerWaiver;
		fx.lifecycle = lifecycle;
		fx.anchors = [{ entity: "steel-chest", x: 1, y: 1, name: "scratch" }];
		return m;
	};
	assert.throws(() => validateGalleryManifest(withTransferLifecycle({
		version: 1, mutable: ["scratch"], act: "transfer", expect: "gate-failure",
		setup: [{ op: "spawn_item", name: "iron-plate", count: 100, into: "scratch" }],
		verify: [{ check: "physical_read", end: "source", locator: { anchor: "scratch" }, read: "item_count", item: "iron-plate", op: "eq", expected: 100 }],
	}), { requireArtifacts: false }), /dest-end arm_hook/);
	assert.throws(() => validateGalleryManifest(withTransferLifecycle({
		version: 1, mutable: ["scratch"], act: "transfer", expect: "gate-failure",
		setup: [{ op: "arm_hook", name: "test_force_item_loss", value: 5, end: "dest" }],
		verify: [{ check: "report_field", path: "validation_success", op: "eq", expected: false }],
	}), { requireArtifacts: false }), /source-preserved witness|physical witness/);
	assert.throws(() => validateGalleryManifest(withTransferLifecycle({
		version: 1, mutable: ["scratch"], act: "transfer", expect: "gate-failure",
		setup: [{ op: "arm_hook", name: "test_force_item_loss", value: 5, end: "dest" }],
		verify: [{ check: "physical_read", locator: { anchor: "scratch" }, read: "item_count", item: "iron-plate", op: "eq", expected: 100 }],
	}), { requireArtifacts: false }), /end "source"/);
	assert.throws(() => validateGalleryManifest(withTransferLifecycle({
		version: 1, mutable: ["scratch"], act: "transfer",
		setup: [{ op: "spawn_item", name: "iron-plate", count: 100, into: "scratch", end: "dest" }],
	}), { requireArtifacts: false }), /cannot run on the dest end/);
	const teeth = manifest.fixtures.find(fixture => fixture.id === "gate-item-loss");
	assert.ok(teeth, "gate-item-loss fixture present");
	assert.equal(teeth.lifecycle.expect, "gate-failure");
	assert.ok(renderExpectFromLifecycle(teeth).some(line => /GATE MUST REFUSE/.test(line)));

	assert.throws(() => validateGalleryManifest(withTransferLifecycle({
		version: 1, mutable: ["scratch"], act: "transfer", expect: "census-abort",
		setup: [{ op: "spawn_item", name: "iron-plate", count: 100, into: "scratch" }],
		verify: [{ check: "physical_read", end: "source", locator: { anchor: "scratch" }, read: "item_count", item: "iron-plate", op: "eq", expected: 100 }],
	}), { requireArtifacts: false }), /test_force_census_omission/);
	assert.throws(() => validateGalleryManifest(withTransferLifecycle({
		version: 1, mutable: ["scratch"], act: "transfer", expect: "census-abort",
		setup: [
			{ op: "arm_hook", name: "test_force_census_omission", value: true },
			{ op: "arm_hook", name: "test_force_item_loss", value: 5, end: "dest" },
		],
		verify: [{ check: "physical_read", end: "source", locator: { anchor: "scratch" }, read: "item_count", item: "iron-plate", op: "eq", expected: 100 }],
	}), { requireArtifacts: false }), /forbids dest-end ops/);
	assert.throws(() => validateGalleryManifest(withTransferLifecycle({
		version: 1, mutable: ["scratch"], act: "transfer", expect: "census-abort",
		setup: [{ op: "arm_hook", name: "test_force_census_omission", value: true }],
		verify: [{ check: "report_field", path: "reason", op: "eq", expected: "source_census_mismatch" }],
	}), { requireArtifacts: false }), /source-preserved witness|source-end physical_read/);
	const census = manifest.fixtures.find(fixture => fixture.id === "census-omission-abort");
	assert.ok(census, "census-omission-abort fixture present");
	assert.equal(census.lifecycle.expect, "census-abort");
	assert.ok(renderExpectFromLifecycle(census).some(line => /CENSUS MUST REFUSE/.test(line)));

	assert.throws(() => validateGalleryManifest(withTransferLifecycle({
		version: 1, mutable: ["scratch"], act: "transfer", expect: "gate-failure",
		setup: [{ op: "arm_hook", name: "test_force_item_loss", value: 5, end: "dest" }],
		verify: [
			{ check: "physical_read", end: "source", locator: { anchor: "scratch" }, read: "item_count", item: "iron-plate", op: "eq", expected: 100 },
			{ check: "census_pass" },
		],
	}), { requireArtifacts: false }), /census_pass checks require expect "success"/);
	const withPropertyVerify = (verify) => withTransferLifecycle({
		version: 1, mutable: ["scratch"], act: "transfer", verify,
	});
	assert.throws(() => validateGalleryManifest(withPropertyVerify([
		{ check: "physical_read", locator: { anchor: "scratch" }, read: "property", op: "eq", expected: 500 },
	]), { requireArtifacts: false }), /dotted identifier "path"/);
	assert.throws(() => validateGalleryManifest(withPropertyVerify([
		{ check: "physical_read", locator: { anchor: "scratch" }, read: "property",
			path: "burner.remaining-burning-fuel", op: "eq", expected: 1 },
	]), { requireArtifacts: false }), /dotted identifier "path"/);
	assert.throws(() => validateGalleryManifest(withPropertyVerify([
		{ check: "physical_read", locator: { area: true }, read: "property", path: "temperature", op: "eq", expected: 500 },
	]), { requireArtifacts: false }), /needs locator\.anchor/);
	assert.throws(() => validateGalleryManifest(withTransferLifecycle({
		version: 1, mutable: ["scratch"], act: "transfer",
		verify: [
			{ check: "physical_read", locator: { anchor: "scratch" }, read: "property",
				path: "temperature", op: "eq", expected: 500 },
			{ check: "report_field", path: "validation_success", op: "approx", expected: true },
		],
	}), { requireArtifacts: false }), /report_field op "approx" is not implemented/);
	const heat = manifest.fixtures.find(fixture => fixture.id === "omnibus-heat-temperature");
	assert.equal(heat.lifecycle.act, "transfer");
	assert.ok(renderExpectFromLifecycle(heat).some(line => /heat-pipe: temperature eq 500/.test(line)),
		`expected a line naming the property path, got: ${renderExpectFromLifecycle(heat).join(" | ")}`);

	const workhorse = manifest.fixtures.find(fixture => fixture.id === "transfer-workhorse");
	assert.ok((workhorse.lifecycle.verify || []).some(check => check.check === "census_pass"),
		"the workhorse clean transfer must witness the source census ran + passed");
	assert.ok(renderExpectFromLifecycle(workhorse).some(line => /source census ran \+ passed/.test(line)));
});
