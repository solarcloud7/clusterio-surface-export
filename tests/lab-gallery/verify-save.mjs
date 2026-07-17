import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadGalleryManifest } from "./manifest.mjs";

const REMOTE_ROOT = "/tmp/surface-export-lab-gallery-verify";
const GAME_PORT = "34977";
const RCON_PORT = "27977";
const RCON_PASSWORD = "gallery-verify-only";

// Fixtures whose physical state the reload meter measures into `corpus`. The belt pilot and the
// reachability drill are asserted separately (belt census + reachability block), so they are NOT
// in the corpus set.
const CORPUS_EXCLUDED = new Set(["belt-5x5-125-unstacked", "specialized-fluid-reachability"]);

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

// Physical fingerprints carry an exact crafting-progress double; compare numbers with a tiny
// tolerance so a save/load ULP does not fail an otherwise-conserved frozen state, while strings,
// booleans, and integer counts stay exact.
function approxEqual(actual, expected) {
	if (typeof actual === "number" && typeof expected === "number") {
		// Absolute 1e-9 absorbs a crafting-progress save/load ULP (~1e-16) while keeping every
		// integer count, temperature, and energy exact (a drift of 1 fails).
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
			if (!approxEqual(reads[key], value)) {
				throw new Error(`${role} corpus ${id}.${key} is ${JSON.stringify(reads[key])}, expected ${JSON.stringify(value)}`);
			}
		}
	}
	return observed;
}

export function buildExpectations(manifest) {
	const corpusFor = role => Object.fromEntries(
		manifest.fixtures
			.filter(fixture => fixture.saveRole === "source" && !CORPUS_EXCLUDED.has(fixture.id))
			// Only the source save carries the platforms; the destination clears them all.
			.filter(() => role === "source")
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
	return {
		source: { corpus: corpusFor("source"), census: censusFor("source") },
		destination: { corpus: corpusFor("destination"), census: censusFor("destination") },
	};
}

export function assertReloadReading(reading, role, expected) {
	if (reading?.reachability?.exists === true && !("mining_target" in reading.reachability)) reading.reachability.mining_target = null;
	assertFields(reading, {
		version: "2.0.77", save_role: role, gallery_storage: true, index_surface: true, game_paused: false,
		transient: { jobs: 0, locks: 0, holds: 0, tombstones: 0 }, index_texts: 12, index_tags: 12,
	});
	assertSurfaceSettings(reading?.surface_settings);
	if (role === "source") {
		assertFields(reading, {
			source_belts: 16, target_belts: 16, source_quantity: 125, physical_stacks: 125,
			maximum_stack: 1, source_line_quantities: [67, 58], target_quantity: 0,
			surface_census: expected.census,
		});
		assertFields(reading.reachability, {
			exists: true, platform_name: "lab-specialized-fluid-r1", drill_name: "electric-mining-drill",
			pressure: 0, gravity: 0, mining_target: null, live_fluidbox_count: 0, read_ok: false, write_ok: false,
		});
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

function docker(arguments_, options = {}) {
	return execFileSync("docker", arguments_, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"], ...options });
}

function sleep(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }

async function verifyOne(options, role, save, expected, boundaryErrors) {
	const config = fileURLToPath(new URL("./isolated-config.ini", import.meta.url));
	const meter = fileURLToPath(new URL("./reload-meter.cjs", import.meta.url));
	docker(["exec", options.container, "test", "!", "-e", REMOTE_ROOT]);
	docker(["exec", options.container, "mkdir", REMOTE_ROOT]);
	let launched = false;
	try {
		docker(["cp", save, `${options.container}:${REMOTE_ROOT}/gallery.zip`]);
		docker(["cp", config, `${options.container}:${REMOTE_ROOT}/config.ini`]);
		docker(["cp", meter, `${options.container}:${REMOTE_ROOT}/reload-meter.cjs`]);
		const launch = `echo $$ > ${REMOTE_ROOT}/verifier.pid; exec timeout 60 /opt/factorio/2.0.77/bin/x64/factorio --start-server ${REMOTE_ROOT}/gallery.zip --config ${REMOTE_ROOT}/config.ini --mod-directory /clusterio/data/instances/clusterio-host-2-instance-1/mods --port ${GAME_PORT} --rcon-port ${RCON_PORT} --rcon-password ${RCON_PASSWORD}`;
		docker(["exec", "-d", options.container, "setsid", "sh", "-c", launch]);
		launched = true;
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
		if (launched) {
			try {
				const pid = docker(["exec", options.container, "cat", `${REMOTE_ROOT}/verifier.pid`]).trim();
				if (/^\d+$/.test(pid)) {
					try { docker(["exec", options.container, "kill", "-TERM", `-${pid}`]); } catch { /* meter normally quits */ }
				} else {
					boundaryErrors.push(new Error(`${role} verifier pid file is invalid: ${JSON.stringify(pid)}`));
				}
			} catch (error) { boundaryErrors.push(new Error(`${role} verifier pid unreadable (launch may have died early): ${error.message}`)); }
		}
		await sleep(500);
		docker(["exec", options.container, "rm", "-rf", "--", REMOTE_ROOT]);
		// Zero-leftover proof at the boundary that can leak: a survived Factorio recreating its
		// write-data after rm -rf must fail HERE, not poison the next role's verification.
		docker(["exec", options.container, "test", "!", "-e", REMOTE_ROOT]);
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
