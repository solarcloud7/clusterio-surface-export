#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseSections, validateSelectedEvidence } from "./reachability-contract.mjs";

const root = new URL("../../", import.meta.url);
const defaultSave = fileURLToPath(new URL("docker/seed-data/lab-saves/lab-gallery-source-surface-export-2.0.77.zip", root));
const manifestPath = fileURLToPath(new URL("tests/lab-gallery/manifest.json", root));
const notebook = fileURLToPath(new URL("tests/specialized-inventory-lab/NOTEBOOK.md", root));
const config = fileURLToPath(new URL("./baked-config.ini", import.meta.url));
const meter = fileURLToPath(new URL("./baked-reachability-meter.cjs", import.meta.url));
const container = "surface-export-host-2";
const remoteRoot = "/tmp/surface-export-specialized-reachability-baked";
const gamePort = "34980";
const rconPort = "27980";
const rconPassword = "specialized-baked-only";

let sections = ["prototype", "placement"];
let save = defaultSave;
let noNotebook = false;
let injectAfterLoadFailure = false;
for (let index = 2; index < process.argv.length; index += 1) {
	const argument = process.argv[index];
	if (argument === "--no-notebook") noNotebook = true;
	else if (argument === "--save") save = process.argv[++index];
	else if (argument === "--sections") sections = parseSections(process.argv[++index] || "");
	else if (argument.startsWith("--sections=")) sections = parseSections(argument.slice(11));
	else if (argument === "--inject-after-load-failure") injectAfterLoadFailure = true;
	else throw new Error(`Unknown argument: ${argument}`);
}

function docker(arguments_, options = {}) {
	return execFileSync("docker", arguments_, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"], ...options });
}

function sleep(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }

function hashFile(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex").toUpperCase();
}

function normalizeLuaJsonEvidence(evidence) {
	for (const row of Object.values(evidence.prototype?.entities || {})) {
		if (!Array.isArray(row.surface_conditions) && row.surface_conditions && Object.keys(row.surface_conditions).length === 0) {
			row.surface_conditions = [];
		}
	}
	if (evidence.placement?.drill && !("mining_target" in evidence.placement.drill)) evidence.placement.drill.mining_target = null;
	return evidence;
}

async function runLoadedSave() {
	if (!existsSync(save)) throw new Error(`baked source save does not exist: ${save}`);
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const expectedHash = manifest.saves?.source?.sha256;
	const actualHash = hashFile(save);
	if (actualHash !== expectedHash) throw new Error(`baked source SHA-256 is ${actualHash}, expected ${expectedHash}`);
	docker(["exec", container, "test", "!", "-e", remoteRoot]);
	docker(["exec", container, "mkdir", remoteRoot]);
	let launched = false;
	try {
		docker(["cp", save, `${container}:${remoteRoot}/source.zip`]);
		docker(["cp", config, `${container}:${remoteRoot}/config.ini`]);
		docker(["cp", meter, `${container}:${remoteRoot}/baked-reachability-meter.cjs`]);
		const launch = `echo $$ > ${remoteRoot}/runner.pid; exec timeout 60 /opt/factorio/2.0.77/bin/x64/factorio --start-server ${remoteRoot}/source.zip --config ${remoteRoot}/config.ini --mod-directory /clusterio/data/instances/clusterio-host-2-instance-1/mods --port ${gamePort} --rcon-port ${rconPort} --rcon-password ${rconPassword}`;
		docker(["exec", "-d", container, "setsid", "sh", "-c", launch]);
		launched = true;
		const encodedSections = Buffer.from(JSON.stringify(sections)).toString("base64");
		const deadline = Date.now() + 30_000;
		let output;
		while (Date.now() < deadline) {
			try {
				output = docker(["exec", container, "node", `${remoteRoot}/baked-reachability-meter.cjs`, rconPort, rconPassword, encodedSections]);
				break;
			} catch (error) {
				const detail = `${error.stderr || ""}\n${error.stdout || ""}\n${error.message || ""}`;
				if (!detail.includes("ECONNREFUSED") && !detail.includes("ECONNRESET")) throw error;
				await sleep(500);
			}
		}
		if (!output) throw new Error("baked source RCON did not become ready within 30 seconds");
		if (injectAfterLoadFailure) throw new Error("injected post-load failure");
		return { ...normalizeLuaJsonEvidence(JSON.parse(output)), save, sha256: actualHash };
	} finally {
		if (launched) {
			try {
				const pid = docker(["exec", container, "cat", `${remoteRoot}/runner.pid`]).trim();
				if (/^\d+$/.test(pid)) try { docker(["exec", container, "kill", "-TERM", `-${pid}`]); } catch { /* meter normally quits */ }
			} catch { /* launch can fail before pid write */ }
		}
		await sleep(500);
		docker(["exec", container, "rm", "-rf", "--", remoteRoot]);
		docker(["exec", container, "test", "!", "-e", remoteRoot]);
	}
}

const result = {
	script: "tests/specialized-inventory-lab/run-reachability.mjs",
	prediction: "The pinned baked source reproduces the Factorio 2.0.77 specialized-fluid reachability classification without runtime fixture construction",
	sections, started: new Date().toISOString(), prototype: null, placement: null,
	contract_failures: [], errors: [], reset: "discard-loaded-source-save",
};
try {
	const evidence = await runLoadedSave();
	result.prototype = evidence.prototype || null;
	result.placement = evidence.placement || null;
	result.artifact = { path: evidence.save, sha256: evidence.sha256 };
	result.contract_failures = validateSelectedEvidence(result, sections);
} catch (error) {
	result.errors.push(error.stack || error.message);
} finally {
	result.finished = new Date().toISOString();
	if (!noNotebook) appendFileSync(notebook, `\n\n## ${result.finished} - Baked reachability recertification\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`);
	console.log(JSON.stringify(result, null, 2));
	if (result.errors.length || result.contract_failures.length) process.exitCode = 1;
}
