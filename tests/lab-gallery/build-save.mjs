import { execFileSync } from "node:child_process";
import { constants, copyFileSync, createReadStream, existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { certifyRuntimeApiFile } from "./api-contract.mjs";
import { buildBeltPilot } from "./fixture-layout.mjs";
import { loadGalleryManifest, validateGalleryManifest } from "./manifest.mjs";

export function sleep(milliseconds) {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export function parseArguments(argv) {
	const result = { runtimeApi: null, output: null, instance: "clusterio-host-1-instance-1", dryRun: false };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--runtime-api") result.runtimeApi = argv[++index];
		else if (argument === "--output") result.output = argv[++index];
		else if (argument === "--instance") result.instance = argv[++index];
		else if (argument === "--dry-run") result.dryRun = true;
		else throw new Error(`unknown argument ${argument}`);
	}
	if (!result.runtimeApi) throw new Error("--runtime-api <path> is required");
	if (!result.output) throw new Error("--output <new-save.zip> is required");
	return result;
}

export function assertIdlePreflight(state) {
	for (const field of ["gamePaused", "surfaces", "labStorage", "jobs", "locks", "holds", "tombstones"]) {
		if (state?.[field]) throw new Error(`preflight blocked by ${field}: ${JSON.stringify(state)}`);
	}
	return state;
}

export function isPilotReady(reading) {
	return reading?.exists === true
		&& reading.sourceQuantity === 125
		&& reading.sourceLineQuantities?.[0] === 67
		&& reading.sourceLineQuantities?.[1] === 58
		&& reading.targetQuantity === 0
		&& reading.maximumStack === 1
		&& reading.physicalStacks === 125;
}

export function cleanupAfterBuild(call) {
	const boundary = { cleanup: null, finalPreflight: null, errors: [] };
	try {
		boundary.cleanup = call({ operation: "cleanup" });
		if (boundary.cleanup.exists !== false || boundary.cleanup.success !== true) {
			throw new Error(`gallery cleanup failed: ${JSON.stringify(boundary.cleanup)}`);
		}
	} catch (error) { boundary.errors.push(error); }
	try {
		boundary.finalPreflight = assertIdlePreflight(call({ operation: "preflight" }));
	} catch (error) { boundary.errors.push(error); }
	return boundary;
}

function containerForInstance(instance) {
	const match = /^clusterio-host-(\d+)-instance-1$/.exec(instance);
	if (!match) throw new Error(`unsupported instance ${instance}`);
	return `surface-export-host-${match[1]}`;
}

function dockerTransport(instance) {
	const runtime = readFileSync(new URL("./gallery-runtime.lua", import.meta.url), "utf8");
	return request => {
		const json = JSON.stringify(request);
		if (json.includes("]=]")) throw new Error("request contains unsafe Lua long-string delimiter");
		const command = `/c local request=helpers.json_to_table([=[${json}]=]); local ok,result=pcall(function() ${runtime} end); if ok then rcon.print(helpers.table_to_json(result)) else rcon.print(helpers.table_to_json({success=false,error=tostring(result)})) end`;
		const output = execFileSync("docker", ["exec", "surface-export-controller", "npx", "clusterioctl", "--log-level", "error", "instance", "send-rcon", instance, command, "--config", "/clusterio/tokens/config-control.json"], { encoding: "utf8", timeout: 180_000 });
		const result = JSON.parse(output.trim().split(/\r?\n/).filter(Boolean).at(-1));
		if (result.success !== true) throw new Error(result.error || `gallery operation ${request.operation} failed`);
		return result;
	};
}

async function waitForStableSave(container, remotePath, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	let previous = null;
	do {
		try {
			const size = Number(execFileSync("docker", ["exec", container, "stat", "-c", "%s", remotePath], { encoding: "utf8" }).trim());
			if (size > 0 && size === previous) return size;
			previous = size;
		} catch { previous = null; }
		await sleep(500);
	} while (Date.now() < deadline);
	throw new Error(`save did not stabilize at ${remotePath}`);
}

async function sha256(path) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	const api = certifyRuntimeApiFile(options.runtimeApi);
	const repoRoot = new URL("../../", import.meta.url);
	const manifest = loadGalleryManifest(repoRoot);
	const inventory = validateGalleryManifest(manifest);
	const pilot = buildBeltPilot();
	const plan = { schema: manifest.schema, api, inventory, saveName: manifest.saveName, pilot: pilot.expected };
	if (options.dryRun) { console.log(JSON.stringify({ status: "DRY_RUN", ...plan }, null, 2)); return; }
	if (existsSync(options.output)) throw new Error(`refusing to overwrite ${options.output}`);

	const call = dockerTransport(options.instance);
	const container = containerForInstance(options.instance);
	const remotePath = `/clusterio/data/instances/${options.instance}/saves/${manifest.saveName}.zip`;
	const temporary = join(tmpdir(), `${manifest.saveName}-${randomUUID()}.zip`);
	let buildAttempted = false;
	let published = false;
	let cleanupBoundary = null;
	try {
		assertIdlePreflight(call({ operation: "preflight" }));
		buildAttempted = true;
		const ready = call({ operation: "build", manifest, beltPilot: pilot });
		if (!isPilotReady(ready)) throw new Error(`adopted belt pilot is invalid: ${JSON.stringify(ready)}`);
		const finalized = call({ operation: "finalize" });
		if (!isPilotReady(finalized) || finalized.finalized !== true) throw new Error(`finalized pilot is invalid: ${JSON.stringify(finalized)}`);
		call({ operation: "save", saveName: manifest.saveName });
		await waitForStableSave(container, remotePath);
		execFileSync("docker", ["cp", `${container}:${remotePath}`, temporary], { timeout: 180_000 });
		copyFileSync(temporary, options.output, constants.COPYFILE_EXCL);
		published = true;
		console.log(JSON.stringify({ status: "PASS", ...plan, ready, artifact: { path: options.output, bytes: statSync(options.output).size, sha256: await sha256(options.output) } }, null, 2));
	} finally {
		if (buildAttempted) cleanupBoundary = cleanupAfterBuild(call);
		if (existsSync(temporary)) unlinkSync(temporary);
		if (cleanupBoundary?.errors.length) {
			if (published && existsSync(options.output)) unlinkSync(options.output);
			throw new AggregateError(cleanupBoundary.errors, "lab gallery cleanup boundary failed");
		}
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch(error => { console.error(error); process.exitCode = 1; });
}
