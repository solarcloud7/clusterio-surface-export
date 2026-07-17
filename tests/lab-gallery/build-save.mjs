import { execFileSync } from "node:child_process";
import { constants, copyFileSync, createReadStream, existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { certifyRuntimeApiFile } from "./api-contract.mjs";
import { buildBeltPilot, buildSpecializedReachabilityFixture } from "./fixture-layout.mjs";
import { loadGalleryManifest, validateGalleryManifest } from "./manifest.mjs";

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
	assertLabSafeSurfaces(reading, "source");
	return reading;
}

export function assertDestinationReady(reading) {
	assertTransientIdle(reading);
	if (reading?.saveRole !== "destination") throw new Error(`destination save role is ${reading?.saveRole}`);
	if (reading.sourceBelts !== 0 || reading.targetBelts !== 0) throw new Error("destination still contains baked belts");
	if (reading.reachability?.exists !== false) throw new Error("destination still contains the specialized platform");
	assertLabSafeSurfaces(reading, "destination");
	return reading;
}

function docker(arguments_, options = {}) {
	return execFileSync("docker", arguments_, {
		encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"], ...options,
	});
}

function runtimeCall(container, request) {
	const encoded = Buffer.from(JSON.stringify(request)).toString("base64");
	const output = docker(["exec", container, "node", `${REMOTE_ROOT}/runtime-driver.cjs`, RCON_PORT, RCON_PASSWORD, `${REMOTE_ROOT}/gallery-runtime.lua`, encoded], { timeout: 180_000 });
	return JSON.parse(output.trim().split(/\r?\n/).filter(Boolean).at(-1));
}

async function waitForRuntime(container, request, timeoutMs = 45_000) {
	const deadline = Date.now() + timeoutMs;
	let lastError;
	do {
		try { return runtimeCall(container, request); }
		catch (error) {
			lastError = error;
			const detail = `${error.stderr || ""}\n${error.stdout || ""}\n${error.message || ""}`;
			if (!detail.includes("ECONNREFUSED") && !detail.includes("ECONNRESET")) throw error;
			await sleep(500);
		}
	} while (Date.now() < deadline);
	throw new Error(`isolated Factorio RCON did not become ready: ${lastError?.message}`);
}

async function waitForStableSave(container, remotePath, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	let previous = null;
	do {
		try {
			const size = Number(docker(["exec", container, "stat", "-c", "%s", remotePath]).trim());
			if (size > 0 && size === previous) return size;
			previous = size;
		} catch { previous = null; }
		await sleep(500);
	} while (Date.now() < deadline);
	throw new Error(`save did not stabilize at ${remotePath}`);
}

async function waitForDestination(container, baseRequest, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	let reading;
	do {
		try {
			reading = runtimeCall(container, { ...baseRequest, operation: "inspect" });
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
	const beltPilot = buildBeltPilot();
	const specializedFixture = buildSpecializedReachabilityFixture();
	const plan = { schema: manifest.schema, api, inventory, seed: options.seed, saves: manifest.saves };
	if (options.dryRun) { console.log(JSON.stringify({ status: "DRY_RUN", ...plan }, null, 2)); return; }

	const config = fileURLToPath(new URL("./build-config.ini", import.meta.url));
	const runtime = fileURLToPath(new URL("./gallery-runtime.lua", import.meta.url));
	const driver = fileURLToPath(new URL("./runtime-driver.cjs", import.meta.url));
	const localCopies = [];
	const publishedPaths = [];
	let launched = false;
	try {
		docker(["exec", options.container, "test", "!", "-e", REMOTE_ROOT]);
		docker(["exec", options.container, "mkdir", "-p", `${REMOTE_ROOT}/saves`]);
		for (const [source, destination] of [[options.seed, "seed.zip"], [config, "config.ini"], [runtime, "gallery-runtime.lua"], [driver, "runtime-driver.cjs"]]) {
			docker(["cp", source, `${options.container}:${REMOTE_ROOT}/${destination}`], { timeout: 180_000 });
		}
		const launch = `echo $$ > ${REMOTE_ROOT}/builder.pid; exec timeout 180 /opt/factorio/2.0.77/bin/x64/factorio --start-server ${REMOTE_ROOT}/seed.zip --config ${REMOTE_ROOT}/config.ini --mod-directory /clusterio/data/instances/clusterio-host-2-instance-1/mods --port ${GAME_PORT} --rcon-port ${RCON_PORT} --rcon-password ${RCON_PASSWORD} > ${REMOTE_ROOT}/factorio-stdout.log 2>&1`;
		docker(["exec", "-d", options.container, "setsid", "sh", "-c", launch]);
		launched = true;
		assertIdlePreflight(await waitForRuntime(options.container, { operation: "preflight" }));
		const baseRequest = { manifest, beltPilot, specializedFixture };
		assertSourceReady(runtimeCall(options.container, { ...baseRequest, operation: "normalize_source" }));
		const sourceReading = assertSourceReady(runtimeCall(options.container, { ...baseRequest, operation: "inspect" }));
		runtimeCall(options.container, { operation: "save", saveName: manifest.saves.source.name });
		const sourceRemote = `${REMOTE_ROOT}/saves/${manifest.saves.source.name}.zip`;
		await waitForStableSave(options.container, sourceRemote);
		const sourceTemporary = join(tmpdir(), `${manifest.saves.source.name}-${randomUUID()}.zip`);
		localCopies.push(sourceTemporary);
		docker(["cp", `${options.container}:${sourceRemote}`, sourceTemporary], { timeout: 180_000 });

		runtimeCall(options.container, { ...baseRequest, operation: "prepare_destination" });
		const destinationReading = await waitForDestination(options.container, baseRequest);
		runtimeCall(options.container, { operation: "save", saveName: manifest.saves.destination.name });
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
		try {
			const log = docker(["exec", options.container, "tail", "-n", "120", `${REMOTE_ROOT}/factorio-stdout.log`]);
			console.error(`isolated Factorio tail:\n${log}`);
		} catch { /* launch may fail before the log exists */ }
		for (const path of publishedPaths) if (existsSync(path)) unlinkSync(path);
		throw error;
	} finally {
		if (launched) {
			try {
				const pid = docker(["exec", options.container, "cat", `${REMOTE_ROOT}/builder.pid`]).trim();
				if (/^\d+$/.test(pid)) try { docker(["exec", options.container, "kill", "-TERM", `-${pid}`]); } catch { /* bounded process may have exited */ }
			} catch { /* launch can fail before pid write */ }
		}
		await sleep(500);
		for (const path of localCopies) if (existsSync(path)) unlinkSync(path);
		try { docker(["exec", options.container, "rm", "-rf", "--", REMOTE_ROOT]); } catch { /* preserve primary error */ }
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch(error => { console.error(error); process.exitCode = 1; });
}
