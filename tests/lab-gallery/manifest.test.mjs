import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import test from "node:test";

import { loadGalleryManifest, renderExpectFromLifecycle, validateGalleryManifest } from "./manifest.mjs";

const repoRoot = new URL("../../", import.meta.url);

test("gallery manifest labs are the fixture-referenced categories (lab dirs removed 2026-07-19)", () => {
	// The standing tests/*-lab suite was removed by owner ruling: engine re-certification is a
	// CALCULATED campaign at version-update time (restore runners from the labs-archive-* git tag;
	// the version-certification guard goes red on a pin bump until the campaign re-certifies).
	// manifest.labs is now the category catalog: exactly the set fixtures reference.
	const manifest = loadGalleryManifest(repoRoot);
	const referenced = [...new Set(manifest.fixtures.map(fixture => fixture.labId))].sort();
	assert.deepEqual(manifest.labs.map(lab => lab.id).sort(), referenced);
	// Derived, not pinned. The old hardcoded `fixtures: 27` was a second copy of a count the manifest
	// already owns — every added pad turned CI red until someone bumped a number here, which punished
	// growth without protecting anything (a dropped pad is caught by the roster-completeness gate,
	// which reports RED MISSING in-world, and by review of the manifest diff).
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
	// belt-5x5-125-unstacked retired 2026-07-19: covered by belt-combined-omnibus (conservative,
	// maxStack=1, over-packed corners measured present — owner-adjudicated consolidation).
	const belt = manifest.fixtures.find(fixture => fixture.id === "belt-combined-omnibus");
	assert.equal(belt.labId, "belt-lab");
	assert.equal(belt.saveRole, "source");
	assert.equal(belt.independentOracleRequired, true);
	// The mining fixture superseded the retired lab-specialized-fluid-r1 platform (owner ruling
	// 2026-07-19: hand-built acid-fed uranium miner claims pad 64,22).
	const miner = manifest.fixtures.find(fixture => fixture.id === "mining-drill-acid-feed");
	assert.equal(miner.labId, "specialized-inventory-lab");
	assert.equal(miner.padKind, "pad");
	// Shape, not values — the exact numbers live in the manifest alone (one-truth ruling 2026-07-26).
	assert.deepEqual(Object.keys(miner.fingerprint).sort(),
		["drillAcid", "drillName", "groundItems", "resourceCount", "resourceTotal", "tankAcid"]);
});

test("the corpus is inventoried with independent oracles and stable fingerprints", () => {
	const manifest = loadGalleryManifest(repoRoot);
	const byId = Object.fromEntries(manifest.fixtures.map(fixture => [fixture.id, fixture]));

	// Every omnibus family shares the one platform, carries an independent oracle, and a fingerprint.
	// STRUCTURE only — this test used to also copy six exact fingerprint VALUES (temperature 500,
	// remaining 2000000, ...) out of the manifest and assert the manifest still said them. A second
	// copy of a fact the manifest owns: it could only catch "someone edited the manifest", which the
	// manifest diff in review already shows, while the LIVE drift it looked like it guarded is
	// actually caught by the runners measuring the real pads against the manifest. Deleted 2026-07-26
	// (owner one-truth ruling); shape and cross-reference claims below are the real contract.
	const omnibus = manifest.fixtures.filter(fixture => fixture.id.startsWith("omnibus-"));
	assert.ok(omnibus.length > 0, "omnibus family present");
	for (const fixture of omnibus) {
		assert.equal(fixture.platformName, "lab-omnibus-state-v1");
		assert.equal(fixture.independentOracleRequired, true);
		assert.ok(fixture.fingerprint && typeof fixture.fingerprint === "object");
	}

	// The workhorse is structure-only: ONLY an entity count is fingerprinted — item counts must never
	// be (live drift). The keys are the contract; the count value lives in the manifest alone.
	assert.deepEqual(Object.keys(byId["transfer-workhorse"].fingerprint), ["entities"]);
	assert.equal(typeof byId["transfer-workhorse"].fingerprint.entities, "number");
	assert.match(byId["transfer-workhorse"].note, /drift/i);

	// Layout blueprints are captured for the requested layouts.
	for (const [id, prefix] of [["omnibus-adversarial-inventory", "0eNq"]]) {
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

	// Red tooth: a null opt-out without a waiver reason is rejected. (This used belt-combined-omnibus
	// until it was promoted to a transfer-act fixture with a real owningRunner; any still-waived
	// hand-built pad serves — inserter-held-capacity is one.)
	const unreasoned = clone();
	const waived = unreasoned.fixtures.find(fixture => fixture.id === "inserter-held-capacity");
	delete waived.owningRunnerWaiver;
	assert.throws(() => validateGalleryManifest(unreasoned, { requireArtifacts: false }), /owningRunnerWaiver/);

	// The reasoned null opt-out (as shipped) validates.
	assert.doesNotThrow(() => validateGalleryManifest(clone(), { requireArtifacts: false }));
});

test("every string owningRunner points at a runner that actually exists", () => {
	// A provenance key that names a DELETED runner is a lie about where the fixture's law lives —
	// exactly what the SC-69/SC-6 integration-test deletions orphaned (14 dangling refs, repointed to
	// null+waiver 2026-07-20). A `tests/...` owningRunner MUST resolve on disk; a fixture whose runner
	// was retired uses the null + owningRunnerWaiver opt-out instead.
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
	// Red tooth: arming a hook outside the fail-safe allowlist is rejected at validation.
	assert.throws(() => validateGalleryManifest(withLifecycle({
		version: 1, setup: [{ op: "arm_hook", name: "test_disable_gate", value: true }],
	}), { requireArtifacts: false }), /fail-safe allowlist/);
	// Green path: a fail-safe hook arms fine.
	assert.doesNotThrow(() => validateGalleryManifest(withLifecycle({
		version: 1, setup: [{ op: "arm_hook", name: "test_force_item_loss", value: 5 }],
	}), { requireArtifacts: false }));
	// Red tooth: report_field checks without any physical witness are rejected (grounding rule).
	assert.throws(() => validateGalleryManifest(withLifecycle({
		version: 1,
		verify: [
			{ check: "fingerprint", enabled: false },
			{ check: "report_field", path: "validation.validation_success", op: "eq", expected: true },
		],
	}), { requireArtifacts: false }), /physical witness/);
	// Red tooth: a setup op targeting an undeclared anchor is rejected (pristine-left-half rule).
	assert.throws(() => validateGalleryManifest(withLifecycle({
		version: 1, mutable: [],
		setup: [{ op: "spawn_item", name: "raw-fish", count: 10, into: "anchor:scratch-chest" }],
	}, [{ entity: "steel-chest", x: 1, y: 1, name: "scratch-chest" }]), { requireArtifacts: false }), /mutable anchor/);
	// Green path: declared mutable anchor accepted; renderer emits lines.
	const ok = withLifecycle({
		version: 1, mutable: ["scratch-chest"],
		setup: [{ op: "spawn_item", name: "raw-fish", count: 10, spoil_percent: 0.5, into: "anchor:scratch-chest" }],
		act: "copy-paste",
		verify: [{ check: "physical_read", locator: { anchor: "scratch-chest" }, read: "item_count", item: "raw-fish", op: "eq", expected: 10 }],
	}, [{ entity: "steel-chest", x: 1, y: 1, name: "scratch-chest" }]);
	assert.doesNotThrow(() => validateGalleryManifest(ok, { requireArtifacts: false }));
	const lines = renderExpectFromLifecycle(ok.fixtures.find(fixture => fixture.id === "belt-combined-omnibus"));
	assert.ok(lines.some(line => /raw-fish item_count eq 10/.test(line)));

	// --- gate-failure (sabotage teeth) rules -----------------------------------------------------
	const SUITE = "tests/integration/pad-transfer-suite/run-tests.mjs";
	const withTransferLifecycle = (lifecycle) => {
		const m = clone();
		const fx = m.fixtures.find(fixture => fixture.id === "belt-combined-omnibus");
		fx.owningRunner = SUITE;
		delete fx.owningRunnerWaiver;
		fx.lifecycle = lifecycle;
		fx.anchors = [{ entity: "steel-chest", x: 1, y: 1, name: "scratch" }];
		return m;
	};
	// Red tooth: gate-failure without a declared dest-end sabotage op is rejected.
	assert.throws(() => validateGalleryManifest(withTransferLifecycle({
		version: 1, mutable: ["scratch"], act: "transfer", expect: "gate-failure",
		setup: [{ op: "spawn_item", name: "iron-plate", count: 100, into: "scratch" }],
		verify: [{ check: "physical_read", end: "source", locator: { anchor: "scratch" }, read: "item_count", item: "iron-plate", op: "eq", expected: 100 }],
	}), { requireArtifacts: false }), /dest-end arm_hook/);
	// Red tooth: gate-failure without a source-end physical witness is rejected.
	assert.throws(() => validateGalleryManifest(withTransferLifecycle({
		version: 1, mutable: ["scratch"], act: "transfer", expect: "gate-failure",
		setup: [{ op: "arm_hook", name: "test_force_item_loss", value: 5, end: "dest" }],
		verify: [{ check: "report_field", path: "validation_success", op: "eq", expected: false }],
	}), { requireArtifacts: false }), /source-preserved witness|physical witness/);
	// Red tooth: a gate-failure physical read that forgets end "source" points at a platform that
	// never exists — rejected.
	assert.throws(() => validateGalleryManifest(withTransferLifecycle({
		version: 1, mutable: ["scratch"], act: "transfer", expect: "gate-failure",
		setup: [{ op: "arm_hook", name: "test_force_item_loss", value: 5, end: "dest" }],
		verify: [{ check: "physical_read", locator: { anchor: "scratch" }, read: "item_count", item: "iron-plate", op: "eq", expected: 100 }],
	}), { requireArtifacts: false }), /end "source"/);
	// Red tooth: dest-end ops are sabotage-only (no dest-end spawn_item).
	assert.throws(() => validateGalleryManifest(withTransferLifecycle({
		version: 1, mutable: ["scratch"], act: "transfer",
		setup: [{ op: "spawn_item", name: "iron-plate", count: 100, into: "scratch", end: "dest" }],
	}), { requireArtifacts: false }), /cannot run on the dest end/);
	// Green path: the shipped gate-item-loss shape validates and renders the refusal banner.
	const teeth = manifest.fixtures.find(fixture => fixture.id === "gate-item-loss");
	assert.ok(teeth, "gate-item-loss fixture present");
	assert.equal(teeth.lifecycle.expect, "gate-failure");
	assert.ok(renderExpectFromLifecycle(teeth).some(line => /GATE MUST REFUSE/.test(line)));

	// --- census-abort (SC-6) rules ---------------------------------------------------------------
	// Red tooth: census-abort without the source-end census hook is rejected.
	assert.throws(() => validateGalleryManifest(withTransferLifecycle({
		version: 1, mutable: ["scratch"], act: "transfer", expect: "census-abort",
		setup: [{ op: "spawn_item", name: "iron-plate", count: 100, into: "scratch" }],
		verify: [{ check: "physical_read", end: "source", locator: { anchor: "scratch" }, read: "item_count", item: "iron-plate", op: "eq", expected: 100 }],
	}), { requireArtifacts: false }), /test_force_census_omission/);
	// Red tooth: census-abort with ANY dest-end op is a contradiction (dest never contacted).
	assert.throws(() => validateGalleryManifest(withTransferLifecycle({
		version: 1, mutable: ["scratch"], act: "transfer", expect: "census-abort",
		setup: [
			{ op: "arm_hook", name: "test_force_census_omission", value: true },
			{ op: "arm_hook", name: "test_force_item_loss", value: 5, end: "dest" },
		],
		verify: [{ check: "physical_read", end: "source", locator: { anchor: "scratch" }, read: "item_count", item: "iron-plate", op: "eq", expected: 100 }],
	}), { requireArtifacts: false }), /forbids dest-end ops/);
	// Red tooth: census-abort without a source-preserved physical witness is rejected.
	assert.throws(() => validateGalleryManifest(withTransferLifecycle({
		version: 1, mutable: ["scratch"], act: "transfer", expect: "census-abort",
		setup: [{ op: "arm_hook", name: "test_force_census_omission", value: true }],
		verify: [{ check: "report_field", path: "reason", op: "eq", expected: "source_census_mismatch" }],
	}), { requireArtifacts: false }), /source-preserved witness|source-end physical_read/);
	// Green path: the shipped census-omission-abort shape validates and renders its banner.
	const census = manifest.fixtures.find(fixture => fixture.id === "census-omission-abort");
	assert.ok(census, "census-omission-abort fixture present");
	assert.equal(census.lifecycle.expect, "census-abort");
	assert.ok(renderExpectFromLifecycle(census).some(line => /CENSUS MUST REFUSE/.test(line)));

	// Red tooth: a census_pass check on a non-success expect is rejected (it witnesses a CLEAN
	// transfer's census; a refusal never produces the pass artifact).
	assert.throws(() => validateGalleryManifest(withTransferLifecycle({
		version: 1, mutable: ["scratch"], act: "transfer", expect: "gate-failure",
		setup: [{ op: "arm_hook", name: "test_force_item_loss", value: 5, end: "dest" }],
		verify: [
			{ check: "physical_read", end: "source", locator: { anchor: "scratch" }, read: "item_count", item: "iron-plate", op: "eq", expected: 100 },
			{ check: "census_pass" },
		],
	}), { requireArtifacts: false }), /census_pass checks require expect "success"/);
	// --- declarative property read rules ---------------------------------------------------------
	// These shipped without teeth in #141 and the review caught it; every other rule in this test has
	// an assert.throws, and a validator rule with no red tooth is a rule nobody has proven fires.
	const withPropertyVerify = (verify) => withTransferLifecycle({
		version: 1, mutable: ["scratch"], act: "transfer", verify,
	});
	// Red tooth: a property read with no path.
	assert.throws(() => validateGalleryManifest(withPropertyVerify([
		{ check: "physical_read", locator: { anchor: "scratch" }, read: "property", op: "eq", expected: 500 },
	]), { requireArtifacts: false }), /dotted identifier "path"/);
	// Red tooth: a path that is not a dotted identifier chain (the charset is the security boundary;
	// the Lua reader re-checks it, but a typo must not need a cluster to surface).
	assert.throws(() => validateGalleryManifest(withPropertyVerify([
		{ check: "physical_read", locator: { anchor: "scratch" }, read: "property",
			path: "burner.remaining-burning-fuel", op: "eq", expected: 1 },
	]), { requireArtifacts: false }), /dotted identifier "path"/);
	// Red tooth: an area locator cannot identify an entity for a property read. There is deliberately
	// NO "entity_name" escape hatch — restating the prototype name is the duplication that made a
	// typo possible in the first place, so the anchor is the only way in.
	assert.throws(() => validateGalleryManifest(withPropertyVerify([
		{ check: "physical_read", locator: { area: true }, read: "property", path: "temperature", op: "eq", expected: 500 },
	]), { requireArtifacts: false }), /needs locator\.anchor/);
	// Red tooth: an op the ORCHESTRATOR cannot run must fail here, not after the transfer fires.
	// evalReportField implements only "eq"; "approx" is valid for physical reads and not for these.
	assert.throws(() => validateGalleryManifest(withTransferLifecycle({
		version: 1, mutable: ["scratch"], act: "transfer",
		verify: [
			{ check: "physical_read", locator: { anchor: "scratch" }, read: "property",
				path: "temperature", op: "eq", expected: 500 },
			{ check: "report_field", path: "validation_success", op: "approx", expected: true },
		],
	}), { requireArtifacts: false }), /report_field op "approx" is not implemented/);
	// Green path: the shipped shape validates, and the rendered line names the PATH — without it two
	// property checks on one pad render identically and a failure cannot say which broke.
	const heat = manifest.fixtures.find(fixture => fixture.id === "omnibus-heat-temperature");
	assert.equal(heat.lifecycle.act, "transfer");
	assert.ok(renderExpectFromLifecycle(heat).some(line => /heat-pipe: temperature eq 500/.test(line)),
		`expected a line naming the property path, got: ${renderExpectFromLifecycle(heat).join(" | ")}`);

	// Green path: the workhorse carries a census_pass witness on its clean transfer.
	const workhorse = manifest.fixtures.find(fixture => fixture.id === "transfer-workhorse");
	assert.ok((workhorse.lifecycle.verify || []).some(check => check.check === "census_pass"),
		"the workhorse clean transfer must witness the source census ran + passed");
	assert.ok(renderExpectFromLifecycle(workhorse).some(line => /source census ran \+ passed/.test(line)));
});
