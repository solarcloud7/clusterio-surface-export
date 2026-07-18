import { constants, copyFileSync, createReadStream, existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	docker, launchIsolatedFactorio, runtimeCall, tailFactorioLog,
	teardownIsolatedFactorio, waitForRuntime, waitForStableSave,
} from "./isolated-factorio.mjs";
import { certifyRuntimeApiFile } from "./api-contract.mjs";
import { buildBeltPilot, buildSpecializedReachabilityFixture } from "./fixture-layout.mjs";
import { CORPUS_EXCLUDED, loadGalleryManifest, meterMiningTarget, validateGalleryManifest } from "./manifest.mjs";

const REMOTE_ROOT = "/tmp/surface-export-lab-gallery-build";
const GAME_PORT = "34979";
const RCON_PORT = "27979";
const RCON_PASSWORD = "gallery-build-only";

export function sleep(milliseconds) {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export function parseArguments(argv) {
	const result = {
		runtimeApi: null, seed: null, sourceOutput: null, destinationOutput: null,
		container: "surface-export-host-2", dryRun: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--runtime-api") result.runtimeApi = argv[++index];
		else if (argument === "--seed") result.seed = argv[++index];
		else if (argument === "--source-output") result.sourceOutput = argv[++index];
		else if (argument === "--destination-output") result.destinationOutput = argv[++index];
		else if (argument === "--container") result.container = argv[++index];
		else if (argument === "--dry-run") result.dryRun = true;
		else throw new Error(`unknown argument ${argument}`);
	}
	for (const [flag, field] of [["runtime-api", "runtimeApi"], ["seed", "seed"], ["source-output", "sourceOutput"], ["destination-output", "destinationOutput"]]) {
		if (!result[field]) throw new Error(`--${flag} <path> is required`);
	}
	if (!/^surface-export-host-\d+$/.test(result.container)) throw new Error(`unsupported container ${result.container}`);
	if (result.sourceOutput === result.destinationOutput) throw new Error("source and destination outputs must differ");
	return result;
}

export function assertIdlePreflight(state) {
	for (const field of ["gamePaused", "jobs", "locks", "holds", "tombstones"]) {
		if (state?.[field]) throw new Error(`preflight blocked by ${field}: ${JSON.stringify(state)}`);
	}
	return state;
}

function assertTransientIdle(reading) {
	return assertIdlePreflight(reading?.transient || {});
}

function assertLabSafeSurfaces(reading, role) {
	// The gate must be unsatisfiable-by-omission: a runtime field rename or dropped field
	// fails loudly instead of silently skipping every check.
	if (!Array.isArray(reading?.surfaceSettings) || reading.surfaceSettings.length === 0) {
		throw new Error(`${role} reading is missing surfaceSettings`);
	}
	if (!Array.isArray(reading?.census?.surfaces) || reading.census.surfaces.length === 0) {
		throw new Error(`${role} reading is missing census.surfaces`);
	}
	if (reading.surfaceSettings.length !== reading.census.surfaces.length) {
		throw new Error(`${role} surface settings census is incomplete`);
	}
	for (const surface of reading.surfaceSettings) {
		// Platform surfaces are measured fixtures whose physics are engine-managed and must
		// not be mutated; the gate requires their row PRESENT but judges only non-platforms.
		if (surface.isPlatform === true) continue;
		if (surface.generateWithLabTiles !== true || surface.hasGlobalElectricNetwork !== true || surface.ignoreSurfaceConditions !== true) {
			throw new Error(`${role} surface settings are not lab-safe: ${JSON.stringify(surface)}`);
		}
	}
}

export function assertSourceReady(reading) {
	assertTransientIdle(reading);
	if (reading?.saveRole !== "source") throw new Error(`source save role is ${reading?.saveRole}`);
	if (reading.beltFixtureExact !== true) throw new Error("source belt fixture is not exact");
	if (reading.reachabilityFixtureExact !== true) throw new Error("source reachability fixture is not exact");
	if (reading.corpusExact !== true) {
		throw new Error(`source corpus fingerprints are not exact: ${JSON.stringify(reading.corpusGate?.mismatches || reading.corpusGate)}`);
	}
	assertLabSafeSurfaces(reading, "source");
	return reading;
}

// Roster-completeness gate, independent of the runtime's own corpusExact boolean: the MEASURED
// corpus must cover exactly the manifest source roster minus the corpus-excluded set, and the gate's
// fixture/field tallies must equal the counts DERIVED from the manifest (never hardcoded). A whole
// fixture silently dropped from the measured set — the satisfiable-by-omission hole — fails here.
export function expectedSourceRoster(manifest, excluded = CORPUS_EXCLUDED) {
	return manifest.fixtures.filter(fixture => fixture.saveRole === "source" && !excluded.has(fixture.id));
}

export function assertCorpusRoster(reading, manifest, excluded = CORPUS_EXCLUDED) {
	const expected = expectedSourceRoster(manifest, excluded);
	const expectedIds = expected.map(fixture => fixture.id).sort();
	const measured = Object.keys(reading?.corpus || {}).sort();
	if (JSON.stringify(measured) !== JSON.stringify(expectedIds)) {
		throw new Error(`source corpus roster is ${JSON.stringify(measured)}, expected ${JSON.stringify(expectedIds)}`);
	}
	const gate = reading?.corpusGate || {};
	if (gate.fixturesMeasured !== expectedIds.length) {
		throw new Error(`corpus fixturesMeasured is ${gate.fixturesMeasured}, expected ${expectedIds.length}`);
	}
	if (gate.expectedFixtures !== expectedIds.length) {
		throw new Error(`corpus expectedFixtures is ${gate.expectedFixtures}, expected ${expectedIds.length}`);
	}
	const expectedFields = expected.reduce((sum, fixture) => sum + Object.keys(fixture.fingerprint || {}).length, 0);
	if (gate.fieldsChecked !== expectedFields) {
		throw new Error(`corpus fieldsChecked is ${gate.fieldsChecked}, expected ${expectedFields}`);
	}
	return reading;
}

// Census gate (replaces the deleted remove_unrelated_surfaces fail-loud control): the live surface
// roster and per-surface entity counts must match the manifest census exactly, so a stray mod
// surface, a lingering "-retired" index, or an unexpected entity fails the BUILD before a
// non-reproducible census is baked and re-pinned.
export function assertCensusMatches(reading, expectedCensus, role) {
	const surfaces = reading?.census?.surfaces;
	if (!Array.isArray(surfaces) || surfaces.length === 0) throw new Error(`${role} reading is missing census.surfaces`);
	const actualNames = surfaces.map(surface => surface.name).sort();
	const expectedNames = expectedCensus.surfaces.map(surface => surface.name).sort();
	if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
		throw new Error(`${role} census surfaces are ${JSON.stringify(actualNames)}, expected ${JSON.stringify(expectedNames)}`);
	}
	const expectedEntities = Object.fromEntries(expectedCensus.surfaces.map(surface => [surface.name, surface.entityCount]));
	for (const surface of surfaces) {
		if (surface.entityCount !== expectedEntities[surface.name]) {
			throw new Error(`${role} surface ${surface.name} has ${surface.entityCount} entities, expected ${expectedEntities[surface.name]}`);
		}
	}
	if (reading.census.totalEntities !== expectedCensus.totalEntities) {
		throw new Error(`${role} total entities ${reading.census.totalEntities}, expected ${expectedCensus.totalEntities}`);
	}
	return reading;
}

export function assertDestinationReady(reading) {
	assertTransientIdle(reading);
	if (reading?.saveRole !== "destination") throw new Error(`destination save role is ${reading?.saveRole}`);
	if (reading.sourceBelts !== 0 || reading.targetBelts !== 0) throw new Error("destination still contains baked belts");
	if (reading.reachability?.exists !== false) throw new Error("destination still contains the specialized platform");
	// Generalized to the full roster: every one of the eight platforms must be gone, not just the
	// reachability one, before the destination save is accepted. Key on surface NAME, not the
	// `.platform` back-reference: after destroy(0) a surface can linger in game.surfaces mid-cleanup
	// with its back-reference already nil, which would slip a truthy-.platform filter and bake a
	// non-reproducible chunk total into the pin.
	const platformSurfaces = (reading.census?.surfaces || []).filter(surface => surface.platform || /^platform-/.test(surface.name || ""));
	if (platformSurfaces.length) throw new Error(`destination still has platform surfaces: ${platformSurfaces.map(surface => surface.platform || surface.name).join(",")}`);
	if (reading.corpus && Object.keys(reading.corpus).length) {
		throw new Error(`destination still measures corpus fixtures: ${Object.keys(reading.corpus).join(",")}`);
	}
	assertLabSafeSurfaces(reading, "destination");
	return reading;
}

async function waitForDestination(call, baseRequest, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	let reading;
	do {
		try {
			reading = call({ ...baseRequest, operation: "inspect" });
			try { return assertDestinationReady(reading); } catch { /* scheduled deletion has not settled */ }
		} catch (error) {
			const detail = `${error.stderr || ""}\n${error.stdout || ""}\n${error.message || ""}`;
			if (!detail.includes("Connection closed") && !detail.includes("ECONNREFUSED") && !detail.includes("ECONNRESET")) throw error;
		}
		await sleep(250);
	} while (Date.now() < deadline);
	throw new Error(`destination did not settle: ${JSON.stringify(reading)}`);
}

async function fileRecord(path) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return { path, bytes: statSync(path).size, sha256: hash.digest("hex").toUpperCase() };
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	for (const path of [options.runtimeApi, options.seed]) if (!existsSync(path)) throw new Error(`input does not exist: ${path}`);
	for (const path of [options.sourceOutput, options.destinationOutput]) if (existsSync(path)) throw new Error(`refusing to overwrite ${path}`);
	const api = certifyRuntimeApiFile(options.runtimeApi);
	const repoRoot = new URL("../../", import.meta.url);
	const manifest = loadGalleryManifest(repoRoot);
	const inventory = validateGalleryManifest(manifest, { requireArtifacts: false });
	// The belt pilot layout and the reachability locators come from fixture-layout; their EXPECTED
	// fingerprint values come from the manifest (single source of truth), never hardcoded copies.
	const beltFixture = manifest.fixtures.find(fixture => fixture.id === "belt-5x5-125-unstacked");
	const reachabilityFixture = manifest.fixtures.find(fixture => fixture.id === "specialized-fluid-reachability");
	const beltPilot = {
		...buildBeltPilot(),
		expected: {
			beltCount: beltFixture.fingerprint.beltCount,
			sourceQuantity: beltFixture.fingerprint.quantity,
			sourceLineQuantities: beltFixture.fingerprint.lineQuantities,
			physicalStacks: beltFixture.fingerprint.physicalStacks,
			maximumStack: beltFixture.fingerprint.maximumStack,
			targetQuantity: 0,
		},
	};
	const specializedFixture = {
		...buildSpecializedReachabilityFixture(),
		expected: {
			pressure: reachabilityFixture.fingerprint.pressure,
			gravity: reachabilityFixture.fingerprint.gravity,
			miningTarget: meterMiningTarget(reachabilityFixture.fingerprint.miningTarget),
			liveFluidboxCount: reachabilityFixture.fingerprint.liveFluidboxCount,
			readOk: reachabilityFixture.fingerprint.readOk,
			writeOk: reachabilityFixture.fingerprint.writeOk,
		},
	};
	const plan = { schema: manifest.schema, api, inventory, seed: options.seed, saves: manifest.saves };
	if (options.dryRun) { console.log(JSON.stringify({ status: "DRY_RUN", ...plan }, null, 2)); return; }

	const config = fileURLToPath(new URL("./build-config.ini", import.meta.url));
	const runtime = fileURLToPath(new URL("./gallery-runtime.lua", import.meta.url));
	const driver = fileURLToPath(new URL("./runtime-driver.cjs", import.meta.url));
	const localCopies = [];
	const publishedPaths = [];
	const boundaryErrors = [];
	// A plain teardown reference so the finally cleans up even if the launch itself dies mid-copy
	// (self-clean parity with the pre-dedup driver, which always rm -rf'd the remote root).
	const teardownHandle = { container: options.container, remoteRoot: REMOTE_ROOT };
	const ports = { rconPort: RCON_PORT, rconPassword: RCON_PASSWORD };
	let handle = null;
	try {
		handle = launchIsolatedFactorio({
			container: options.container, remoteRoot: REMOTE_ROOT,
			seed: options.seed, config,
			files: [[runtime, "gallery-runtime.lua"], [driver, "runtime-driver.cjs"]],
			gamePort: GAME_PORT, rconPort: RCON_PORT, rconPassword: RCON_PASSWORD,
			timeoutSeconds: 180, runtimeLuaName: "gallery-runtime.lua",
		});
		const call = request => runtimeCall(handle, ports, request);
		assertIdlePreflight(await waitForRuntime(handle, ports, { operation: "preflight" }, 45_000));
		// The runtime only needs the index catalog and the fingerprints. Ship a lean manifest (no
		// prose, per-fixture mod pins, saves, contract, or layout blueprints) so the base64 request
		// stays well under the OS argv limit and cannot carry a Lua long-string delimiter.
		const leanManifest = {
			schema: manifest.schema,
			surfaceName: manifest.surfaceName,
			labs: manifest.labs.map(({ id, title, zone }) => ({ id, title, zone })),
			fixtures: manifest.fixtures.map(({ id, fingerprint }) => ({ id, fingerprint })),
		};
		const baseRequest = { manifest: leanManifest, beltPilot, specializedFixture };
		assertSourceReady(call({ ...baseRequest, operation: "normalize_source" }));
		const sourceReading = assertSourceReady(call({ ...baseRequest, operation: "inspect" }));
		assertCorpusRoster(sourceReading, manifest);
		assertCensusMatches(sourceReading, manifest.saves.source.expectedCensus, "source");
		call({ operation: "save", saveName: manifest.saves.source.name });
		const sourceRemote = `${REMOTE_ROOT}/saves/${manifest.saves.source.name}.zip`;
		await waitForStableSave(options.container, sourceRemote);
		const sourceTemporary = join(tmpdir(), `${manifest.saves.source.name}-${randomUUID()}.zip`);
		localCopies.push(sourceTemporary);
		docker(["cp", `${options.container}:${sourceRemote}`, sourceTemporary], { timeout: 180_000 });

		call({ ...baseRequest, operation: "prepare_destination" });
		const destinationReading = await waitForDestination(call, baseRequest);
		assertCensusMatches(destinationReading, manifest.saves.destination.expectedCensus, "destination");
		call({ operation: "save", saveName: manifest.saves.destination.name });
		const destinationRemote = `${REMOTE_ROOT}/saves/${manifest.saves.destination.name}.zip`;
		await waitForStableSave(options.container, destinationRemote);
		const destinationTemporary = join(tmpdir(), `${manifest.saves.destination.name}-${randomUUID()}.zip`);
		localCopies.push(destinationTemporary);
		docker(["cp", `${options.container}:${destinationRemote}`, destinationTemporary], { timeout: 180_000 });

		copyFileSync(sourceTemporary, options.sourceOutput, constants.COPYFILE_EXCL);
		publishedPaths.push(options.sourceOutput);
		copyFileSync(destinationTemporary, options.destinationOutput, constants.COPYFILE_EXCL);
		publishedPaths.push(options.destinationOutput);
		console.log(JSON.stringify({
			status: "PASS", ...plan, sourceReading, destinationReading,
			artifacts: { source: await fileRecord(options.sourceOutput), destination: await fileRecord(options.destinationOutput) },
		}, null, 2));
	} catch (error) {
		try { console.error(`isolated Factorio tail:\n${tailFactorioLog(teardownHandle)}`); }
		catch { /* launch may fail before the log exists */ }
		for (const path of publishedPaths) if (existsSync(path)) unlinkSync(path);
		throw error;
	} finally {
		await teardownIsolatedFactorio(teardownHandle, boundaryErrors);
		for (const path of localCopies) if (existsSync(path)) unlinkSync(path);
	}
	if (boundaryErrors.length) throw new AggregateError(boundaryErrors, "build passed but the teardown boundary was not clean");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch(error => { console.error(error); process.exitCode = 1; });
}
