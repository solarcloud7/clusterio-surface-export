#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseSections, validateSelectedEvidence } from "./reachability-contract.mjs";
import { requireLuaSuccess } from "./reachability-runner-helpers.mjs";

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
const FIXTURE_ID = "specialized-fluid-reachability";
const RELEASE_COMMAND = "node tests/specialized-inventory-lab/run-reachability.mjs --release-lease";

export class LeaseBlockedError extends Error {
	constructor(message) {
		super(message);
		this.name = "LeaseBlockedError";
	}
}

export function resolveFixture(manifest, fixtureId = FIXTURE_ID) {
	const fixture = (manifest?.fixtures || []).find(row => row.id === fixtureId);
	if (!fixture) throw new Error(`manifest has no fixture ${fixtureId}`);
	for (const field of ["revision", "fingerprint"]) {
		if (fixture[field] === undefined) throw new Error(`fixture ${fixtureId} is missing ${field}`);
	}
	return fixture;
}

// Machine-checks the manifest fingerprint against the measured evidence, per section run —
// the standard requires the fixture ID/revision verified before use, and a re-baked
// revision must never silently continue an older revision's evidence series.
export function verifyFixtureFingerprint(fixture, evidence, sections) {
	const failures = [];
	const want = fixture.fingerprint;
	const check = (field, actual, expected) => {
		if (actual !== expected) failures.push(`fingerprint ${field}: measured ${JSON.stringify(actual)}, manifest rev ${fixture.revision} expects ${JSON.stringify(expected)}`);
	};
	if (sections.includes("prototype")) {
		check("pressure", evidence.prototype?.platform?.pressure, want.pressure);
		check("gravity", evidence.prototype?.platform?.gravity, want.gravity);
	}
	if (sections.includes("placement")) {
		const drill = evidence.placement?.drill;
		check("drillName", drill?.name, want.drillName);
		check("miningTarget", drill?.mining_target ?? null, want.miningTarget);
		check("liveFluidboxCount", drill?.live_fluidbox_count, want.liveFluidboxCount);
		check("readOk", drill?.read_ok, want.readOk);
		check("writeOk", drill?.write_ok, want.writeOk);
	}
	return failures;
}

export function parseRunnerArguments(argv) {
	const options = {
		sections: ["prototype", "placement"], save: defaultSave,
		noNotebook: false, injectAfterLoadFailure: false, releaseLease: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--no-notebook") options.noNotebook = true;
		else if (argument === "--save") options.save = argv[++index];
		else if (argument === "--sections") options.sections = parseSections(argv[++index] || "");
		else if (argument.startsWith("--sections=")) options.sections = parseSections(argument.slice(11));
		else if (argument === "--inject-after-load-failure") options.injectAfterLoadFailure = true;
		else if (argument === "--release-lease") options.releaseLease = true;
		else throw new Error(`Unknown argument: ${argument}`);
	}
	return options;
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

function acquireLease() {
	try { docker(["exec", container, "test", "!", "-e", remoteRoot]); }
	catch {
		throw new LeaseBlockedError(
			`stale lease ${remoteRoot} exists in ${container} (a previous run crashed before its finalizer). `
			+ `This run is BLOCKED, not a measurement failure. Recover with: ${RELEASE_COMMAND}`,
		);
	}
	docker(["exec", container, "mkdir", remoteRoot]);
}

function releaseLeaseNow() {
	docker(["exec", container, "rm", "-rf", "--", remoteRoot]);
	docker(["exec", container, "test", "!", "-e", remoteRoot]);
	console.log(JSON.stringify({ status: "LEASE_RELEASED", container, remoteRoot }));
}

async function runLoadedSave(fixture, options) {
	const { save, sections, injectAfterLoadFailure } = options;
	if (!existsSync(save)) throw new Error(`baked source save does not exist: ${save}`);
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const expectedHash = manifest.saves?.source?.sha256;
	const actualHash = hashFile(save);
	if (actualHash !== expectedHash) throw new Error(`baked source SHA-256 is ${actualHash}, expected ${expectedHash}`);
	acquireLease();
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
		const evidence = requireLuaSuccess(JSON.parse(output), `${container} baked meter`);
		return { ...normalizeLuaJsonEvidence(evidence), save, sha256: actualHash, fixture: { id: fixture.id, revision: fixture.revision } };
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

async function main() {
	const options = parseRunnerArguments(process.argv.slice(2));
	if (options.releaseLease) { releaseLeaseNow(); return; }
	const result = {
		script: "tests/specialized-inventory-lab/run-reachability.mjs",
		prediction: "The pinned baked source reproduces the Factorio 2.0.77 specialized-fluid reachability classification without runtime fixture construction",
		sections: options.sections, started: new Date().toISOString(), status: null, fixture: null, prototype: null, placement: null,
		contract_failures: [], fingerprint_failures: [], errors: [], reset: "discard-loaded-source-save",
	};
	try {
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		const fixture = resolveFixture(manifest);
		result.fixture = { id: fixture.id, revision: fixture.revision };
		const evidence = await runLoadedSave(fixture, options);
		result.prototype = evidence.prototype || null;
		result.placement = evidence.placement || null;
		result.artifact = { path: evidence.save, sha256: evidence.sha256 };
		result.contract_failures = validateSelectedEvidence(result, options.sections);
		result.fingerprint_failures = verifyFixtureFingerprint(fixture, evidence, options.sections);
		result.status = (result.contract_failures.length || result.fingerprint_failures.length) ? "FAILED" : "PASS";
	} catch (error) {
		// BLOCKED = the run never measured anything (stale lease); FAILED = a measurement or
		// contract defect. The standard requires these never conflate (docs/lab-tests.md).
		result.status = error instanceof LeaseBlockedError ? "BLOCKED" : "FAILED";
		result.errors.push(error.stack || error.message);
	} finally {
		result.finished = new Date().toISOString();
		const fixtureLabel = result.fixture ? `${result.fixture.id} rev ${result.fixture.revision}` : "unresolved fixture";
		if (!options.noNotebook) appendFileSync(notebook, `\n\n## ${result.finished} - Baked reachability recertification (${fixtureLabel}) - ${result.status}\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`);
		console.log(JSON.stringify(result, null, 2));
		if (result.status !== "PASS") process.exitCode = 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch(error => { console.error(error); process.exitCode = 1; });
}
