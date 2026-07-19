import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { docker, launchIsolatedFactorio, sleep, teardownIsolatedFactorio } from "./isolated-factorio.mjs";
import { CORPUS_EXCLUDED, loadGalleryManifest, meterMiningTarget } from "./manifest.mjs";

const REMOTE_ROOT = "/tmp/surface-export-lab-gallery-verify";
const GAME_PORT = "34977";
const RCON_PORT = "27977";
const RCON_PASSWORD = "gallery-verify-only";

export function parseArguments(argv) {
	const result = { sourceSave: null, destinationSave: null, container: "surface-export-host-2" };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--source-save") result.sourceSave = argv[++index];
		else if (argument === "--destination-save") result.destinationSave = argv[++index];
		else if (argument === "--container") result.container = argv[++index];
		else throw new Error(`unknown argument ${argument}`);
	}
	if (!result.sourceSave) throw new Error("--source-save <gallery.zip> is required");
	if (!result.destinationSave) throw new Error("--destination-save <gallery.zip> is required");
	if (!/^surface-export-host-\d+$/.test(result.container)) throw new Error(`unsupported container ${result.container}`);
	return result;
}

function assertFields(reading, expected) {
	for (const [field, value] of Object.entries(expected)) {
		try { assert.deepEqual(reading?.[field], value); }
		catch { throw new Error(`reload field ${field} is ${JSON.stringify(reading?.[field])}, expected ${JSON.stringify(value)}`); }
	}
}

export function assertSurfaceSettings(settings) {
	if (!Array.isArray(settings) || settings.length === 0) throw new Error("surface_settings is empty");
	for (const row of settings) {
		// Platform surfaces are measured fixtures (engine-managed physics); their row must be
		// present and flagged, but the lab-safe trio is judged only on non-platform surfaces.
		if (row?.is_platform === true) continue;
		for (const field of ["generate_with_lab_tiles", "has_global_electric_network", "ignore_surface_conditions"]) {
			if (row?.[field] !== true) throw new Error(`surface ${row?.name || "<unknown>"} ${field} is not true`);
		}
	}
	return settings;
}

// ONLY the crafting-progress and module-bonus-progress doubles absorb a save/load ULP; every OTHER
// fingerprint field (integer counts, temperatures, energies, fluid amounts, coordinates, strings,
// booleans) is compared with exact equality. The 1e-9 tolerance is never applied blanket.
const TOLERANT_DOUBLE_FIELDS = new Set(["progress", "bonusProgress"]);

function approxEqual(key, actual, expected) {
	if (TOLERANT_DOUBLE_FIELDS.has(key) && typeof actual === "number" && typeof expected === "number") {
		return Math.abs(actual - expected) <= 1e-9;
	}
	return actual === expected;
}

export function assertCorpus(actual, expected, role) {
	const observed = actual || {};
	const observedKeys = Object.keys(observed).sort();
	const expectedKeys = Object.keys(expected).sort();
	// Red tooth: a dropped fixture (or an extra one) fails before any value is compared.
	if (JSON.stringify(observedKeys) !== JSON.stringify(expectedKeys)) {
		throw new Error(`${role} corpus fixture set is ${JSON.stringify(observedKeys)}, expected ${JSON.stringify(expectedKeys)}`);
	}
	for (const id of expectedKeys) {
		const reads = observed[id] || {};
		for (const [key, value] of Object.entries(expected[id])) {
			// Red tooth: a dropped or drifted fingerprint field fails; a missing read is undefined.
			if (!approxEqual(key, reads[key], value)) {
				throw new Error(`${role} corpus ${id}.${key} is ${JSON.stringify(reads[key])}, expected ${JSON.stringify(value)}`);
			}
		}
	}
	return observed;
}

export function buildExpectations(manifest) {
	const fixtureById = Object.fromEntries(manifest.fixtures.map(fixture => [fixture.id, fixture]));
	// The source corpus is every source fixture the reload meter measures — the manifest roster minus
	// the separately-asserted belt/reachability set. The destination clears every platform, so its
	// corpus is empty.
	const sourceCorpus = Object.fromEntries(
		manifest.fixtures
			.filter(fixture => fixture.saveRole === "source" && !CORPUS_EXCLUDED.has(fixture.id))
			.map(fixture => [fixture.id, fixture.fingerprint]),
	);
	const censusFor = role => {
		const census = manifest.saves[role].expectedCensus;
		return {
			total_entities: census.totalEntities,
			total_generated_chunks: census.totalGeneratedChunks,
			surface_names: census.surfaces.map(surface => surface.name).sort(),
		};
	};
	// The belt pilot and reachability drill are asserted separately from the corpus, but their
	// EXPECTED values are sourced from the manifest fingerprints (single source of truth), never
	// hardcoded literals — editing a manifest fingerprint changes what the reload gate asserts.
	const beltFingerprint = fixtureById["belt-5x5-125-unstacked"].fingerprint;
	const reachabilityFixture = fixtureById["specialized-fluid-reachability"];
	const reachabilityFingerprint = reachabilityFixture.fingerprint;
	const belt = {
		source_belts: beltFingerprint.beltCount, target_belts: beltFingerprint.beltCount,
		source_quantity: beltFingerprint.quantity, physical_stacks: beltFingerprint.physicalStacks,
		maximum_stack: beltFingerprint.maximumStack, source_line_quantities: beltFingerprint.lineQuantities,
		target_quantity: 0,
	};
	const reachability = {
		exists: true, platform_name: reachabilityFixture.platformName, drill_name: reachabilityFingerprint.drillName,
		pressure: reachabilityFingerprint.pressure, gravity: reachabilityFingerprint.gravity,
		mining_target: meterMiningTarget(reachabilityFingerprint.miningTarget), live_fluidbox_count: reachabilityFingerprint.liveFluidboxCount,
		read_ok: reachabilityFingerprint.readOk, write_ok: reachabilityFingerprint.writeOk,
	};
	return {
		source: { corpus: sourceCorpus, census: censusFor("source"), belt, reachability, labCount: manifest.labs.length },
		destination: { corpus: {}, census: censusFor("destination"), labCount: manifest.labs.length },
	};
}

export function assertReloadReading(reading, role, expected) {
	assertFields(reading, {
		version: "2.0.77", save_role: role, gallery_storage: true, index_surface: true, game_paused: false,
		transient: { jobs: 0, locks: 0, holds: 0, tombstones: 0 },
		// One catalog label + chart tag per lab family — DERIVED from the manifest roster, never
		// hardcoded (the hardcoded 12 went stale the day census-lab joined).
		index_texts: expected.labCount, index_tags: expected.labCount,
	});
	assertSurfaceSettings(reading?.surface_settings);
	if (role === "source") {
		// Belt + reachability EXPECTED values come from the manifest fingerprints (expected.belt /
		// expected.reachability). mining_target is compared as the explicit `false` the meter always
		// emits, so a dropped read is an absent field this assertion rejects — never self-manufactured.
		assertFields(reading, { ...expected.belt, surface_census: expected.census });
		assertFields(reading.reachability, expected.reachability);
	} else if (role === "destination") {
		assertFields(reading, {
			source_belts: 0, target_belts: 0, source_quantity: 0, physical_stacks: 0,
			maximum_stack: 0, source_line_quantities: [0, 0], target_quantity: 0,
			surface_census: expected.census,
		});
		assertFields(reading.reachability, { exists: false });
	} else throw new Error(`unsupported save role ${role}`);
	assertCorpus(reading.corpus, expected.corpus, role);
	return reading;
}

async function verifyOne(options, role, save, expected, boundaryErrors) {
	const config = fileURLToPath(new URL("./isolated-config.ini", import.meta.url));
	const meter = fileURLToPath(new URL("./reload-meter.cjs", import.meta.url));
	// manifest.json rides along: the meter reads its measure anchors from it (single source
	// shared with gallery-runtime.lua).
	const manifestFile = fileURLToPath(new URL("./manifest.json", import.meta.url));
	// The reload meter is invoked directly (reload-meter.cjs over RCON), NOT the runtime-driver
	// protocol, so this driver keeps its own poll loop while reusing the shared launch/teardown.
	const teardownHandle = { container: options.container, remoteRoot: REMOTE_ROOT };
	try {
		launchIsolatedFactorio({
			container: options.container, remoteRoot: REMOTE_ROOT,
			seed: save, config, files: [[meter, "reload-meter.cjs"], [manifestFile, "manifest.json"]],
			gamePort: GAME_PORT, rconPort: RCON_PORT, rconPassword: RCON_PASSWORD, timeoutSeconds: 60,
		});
		const deadline = Date.now() + 30_000;
		let output;
		while (Date.now() < deadline) {
			try { output = docker(["exec", options.container, "node", `${REMOTE_ROOT}/reload-meter.cjs`, RCON_PORT, RCON_PASSWORD]); break; }
			catch (error) {
				const detail = `${error.stderr || ""}\n${error.stdout || ""}\n${error.message || ""}`;
				if (!detail.includes("ECONNREFUSED") && !detail.includes("ECONNRESET")) throw error;
				await sleep(500);
			}
		}
		if (!output) throw new Error(`isolated ${role} RCON did not become ready`);
		const result = JSON.parse(output);
		return assertReloadReading(result.reading, role, expected);
	} finally {
		await teardownIsolatedFactorio(teardownHandle, boundaryErrors);
	}
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	for (const path of [options.sourceSave, options.destinationSave]) if (!existsSync(path)) throw new Error(`save does not exist: ${path}`);
	const manifest = loadGalleryManifest(new URL("../../", import.meta.url));
	const expectations = buildExpectations(manifest);
	const readings = {};
	const boundaryErrors = [];
	for (const role of ["source", "destination"]) readings[role] = await verifyOne(options, role, options[`${role}Save`], expectations[role], boundaryErrors);
	if (boundaryErrors.length) throw new AggregateError(boundaryErrors, "verification passed but the teardown boundary was not clean");
	console.log(JSON.stringify({ status: "PASS", saves: { source: options.sourceSave, destination: options.destinationSave }, readings }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch(error => { console.error(error); process.exitCode = 1; });
}
