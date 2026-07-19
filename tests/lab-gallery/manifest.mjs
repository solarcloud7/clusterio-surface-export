import { readFileSync } from "node:fs";

// Fixtures asserted by a SEPARATE physical path, not the corpus meter (measure_corpus). This is the
// single source of truth for the corpus-excluded set shared by the build-side and reload-side
// roster-completeness gates: the belt pilot is asserted by the belt census and the reachability
// drill by the reachability block. Any OTHER fixture missing from the measured corpus fails loudly.
export const CORPUS_EXCLUDED = new Set(["belt-5x5-125-unstacked", "specialized-fluid-reachability"]);

// The reload meters build their reading from a Lua table, which cannot carry a JSON null (Lua drops
// nil keys). They therefore represent the semantic "no mining target" (manifest miningTarget: null)
// as the explicit sentinel `false`, which is ALWAYS present in the emitted reading — so a dropped
// meter read is an absent field the gate rejects loudly, never normalized to a passing value. This
// translates the manifest's semantic value to what the meter emits (the manifest stays the source of
// truth; the meter merely cannot spell null).
export function meterMiningTarget(manifestValue) {
	return manifestValue === null ? false : manifestValue;
}

export function loadGalleryManifest(repoRoot) {
	return JSON.parse(readFileSync(new URL("tests/lab-gallery/manifest.json", repoRoot), "utf8"));
}

function sameJson(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

export function validateGalleryManifest(manifest, { requireArtifacts = true } = {}) {
	if (manifest?.schema !== "surface-export-lab-gallery-v3") throw new Error("unexpected gallery schema");
	if (manifest.engineVersion !== "2.0.77") throw new Error(`unsupported gallery engine ${manifest.engineVersion}`);
	if (!manifest.mods || manifest.mods.base !== manifest.engineVersion || manifest.mods["space-age"] !== manifest.engineVersion) {
		throw new Error("gallery mod pin set is incomplete");
	}
	for (const role of ["source", "destination"]) {
		const save = manifest.saves?.[role];
		if (save?.role !== role) throw new Error(`missing ${role} save role`);
		if (!/^lab-gallery-[a-z0-9-]+$/.test(save.name || "")) throw new Error(`invalid ${role} save name`);
		if (!/^docker\/seed-data\/lab-saves\/.+\.zip$/.test(save.artifact || "")) throw new Error(`invalid ${role} artifact path`);
		if (!sameJson(save.mods, manifest.mods)) throw new Error(`${role} save mod pins differ from the gallery`);
		if (requireArtifacts && (!/^[A-F0-9]{64}$/.test(save.sha256 || "") || !save.expectedCensus)) {
			throw new Error(`artifact metadata pending for ${role}`);
		}
	}
	if (!Array.isArray(manifest.labs) || manifest.labs.length === 0) throw new Error("gallery has no labs");
	const ids = new Set();
	const zones = new Set();
	for (const lab of manifest.labs) {
		if (!lab?.id || ids.has(lab.id)) throw new Error(`duplicate or missing lab id ${lab?.id}`);
		ids.add(lab.id);
		if (!lab.title || !lab.purpose || !lab.sourcePath) throw new Error(`incomplete lab ${lab.id}`);
		if (!Number.isInteger(lab.zone?.x) || !Number.isInteger(lab.zone?.y)) throw new Error(`invalid zone ${lab.id}`);
		const zone = `${lab.zone.x},${lab.zone.y}`;
		if (zones.has(zone)) throw new Error(`duplicate zone ${zone}`);
		zones.add(zone);
	}
	if (!Array.isArray(manifest.fixtures) || manifest.fixtures.length === 0) throw new Error("gallery has no fixtures");
	const fixtureIds = new Set();
	let sourceFixtures = 0;
	let destinationFixtures = 0;
	for (const fixture of manifest.fixtures) {
		if (!fixture?.id || fixtureIds.has(fixture.id)) throw new Error(`duplicate or missing fixture id ${fixture?.id}`);
		fixtureIds.add(fixture.id);
		if (!Number.isInteger(fixture.revision) || fixture.revision < 1) throw new Error(`invalid revision for ${fixture.id}`);
		if (!ids.has(fixture.labId)) throw new Error(`unknown lab ${fixture.labId} for ${fixture.id}`);
		if (!fixture.name || !fixture.purpose || !fixture.category) throw new Error(`incomplete fixture ${fixture.id}`);
		// owningRunner is a REQUIRED provenance key with an EXPLICIT per-fixture opt-out — never a
		// blanket relaxation. It is either a "tests/..." runner path, or null accompanied by an
		// owningRunnerWaiver reason (the consumables own no single integration runner). A fixture that
		// omits the key entirely is a validation error, so a real runner cannot be silently dropped.
		if (!("owningRunner" in fixture)) throw new Error(`missing owningRunner for ${fixture.id}`);
		if (fixture.owningRunner === null) {
			if (typeof fixture.owningRunnerWaiver !== "string" || !fixture.owningRunnerWaiver) {
				throw new Error(`owningRunner opt-out for ${fixture.id} needs an owningRunnerWaiver reason`);
			}
		} else if (typeof fixture.owningRunner !== "string" || !/^tests\/.+/.test(fixture.owningRunner)) {
			throw new Error(`invalid owningRunner for ${fixture.id}`);
		}
		if (fixture.saveRole === "source") sourceFixtures += 1;
		else if (fixture.saveRole === "destination") destinationFixtures += 1;
		else throw new Error(`invalid save role for ${fixture.id}`);
		if (fixture.engineVersion !== manifest.engineVersion || !sameJson(fixture.mods, manifest.mods)) {
			throw new Error(`engine or mod pins differ for ${fixture.id}`);
		}
		if (!fixture.invariant || !fixture.expectedTerminalVerdict || fixture.independentOracleRequired !== true) {
			throw new Error(`incomplete contract for ${fixture.id}`);
		}
		if (!fixture.fingerprint || typeof fixture.fingerprint !== "object") throw new Error(`missing fingerprint for ${fixture.id}`);
		// v3: every fixture declares a padKind (pad = a stamped test-foundation cell on the omnibus
		// grid; platform = its own platform/hub fixture; surface = a bare-surface fixture). Pads carry
		// their grid origin {x,y}; the migration retired every surface fixture, so a `surface` padKind
		// is accepted but no fixture uses it after the belt pads landed on the grid.
		if (!["pad", "platform", "surface"].includes(fixture.padKind)) throw new Error(`invalid padKind for ${fixture.id}`);
		if (fixture.padKind === "pad" && (!fixture.origin || !Number.isInteger(fixture.origin.x) || !Number.isInteger(fixture.origin.y))) {
			throw new Error(`pad ${fixture.id} needs an integer origin {x,y}`);
		}
	}
	return { labs: manifest.labs.length, fixtures: manifest.fixtures.length, sourceFixtures, destinationFixtures };
}
