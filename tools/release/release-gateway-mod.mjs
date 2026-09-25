#!/usr/bin/env node
// release-gateway-mod — run the Gateway mod release workflow for the committed ZIP in one command
// requires: gh authenticated for this repository; docker/seed-data/mods/surfexp_gateways_<version>.zip committed and
//           identical on origin/main (the workflow checks out main); network access to mods.factorio.com
// produces: a passed validate-only workflow run; without --publish, the exact publish command; with --publish, a
//           passed publish run and a Mod Portal release whose sha1 matches the local ZIP; exit 1 on any refusal
// does not: build or commit the ZIP, bump the version, sync clients, or deploy servers

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "../shared/seeded-instances.mjs";

const WORKFLOW = "gateway-mod.yml";
const PORTAL = "https://mods.factorio.com";

export function gatewayZip(root, version) {
	const resolved = version ?? JSON.parse(readFileSync(join(root, "docker/seed-data/mods-src/surfexp_gateways/info.json"), "utf8")).version;
	const relPath = `docker/seed-data/mods/surfexp_gateways_${resolved}.zip`;
	return { version: resolved, relPath, path: join(root, relPath) };
}

export function checkCommitted({ relPath, exists, localBlob, mainBlob }) {
	if (!exists) return `${relPath} does not exist; build it with tools/surface-export/build-gateway-mod.ps1`;
	if (!mainBlob) return `${relPath} is not on origin/main; merge it before releasing (the workflow checks out main)`;
	if (localBlob !== mainBlob) return `${relPath} differs from origin/main; the workflow would release main's copy`;
	return null;
}

export function publishCommand(version, sha256) {
	return `gh workflow run ${WORKFLOW} --ref main -f version=${version} -f sha256=${sha256} -f publish=true`;
}

export function pickDispatchedRun(runs, requestId) {
	const matches = runs.filter(r => r.event === "workflow_dispatch" && (r.displayTitle ?? "").split(/\s+/).includes(requestId));
	if (matches.length > 1) throw new Error(`${matches.length} runs carry request id ${requestId}: ${matches.map(r => r.databaseId).join(", ")}`);
	return matches[0] ?? null;
}

function defaultRun(cmd, args, { cwd, allowFailure = false } = {}) {
	const result = spawnSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	if (result.error) throw result.error;
	if (result.status === 0) return result.stdout.trim();
	if (allowFailure) return null;
	throw new Error(`${cmd} ${args.join(" ")} failed (exit ${result.status}): ${result.stderr.trim()}`);
}

async function dispatchAndWait({ run, sleep, root, version, sha256, publish, newRequestId }) {
	const requestId = newRequestId();
	run("gh", ["workflow", "run", WORKFLOW, "--ref", "main", "-f", `version=${version}`, "-f", `sha256=${sha256}`,
		"-f", `publish=${publish}`, "-f", `request_id=${requestId}`], { cwd: root });
	let found = null;
	for (let attempt = 0; attempt < 20 && !found; attempt++) {
		await sleep(3000);
		const runs = JSON.parse(run("gh", ["run", "list", "--workflow", WORKFLOW, "--event", "workflow_dispatch",
			"--limit", "50", "--json", "databaseId,displayTitle,event"], { cwd: root }));
		found = pickDispatchedRun(runs, requestId);
	}
	if (!found) throw new Error(`the ${publish ? "publish" : "validate-only"} run did not appear within 60s`);
	const watched = run("gh", ["run", "watch", String(found.databaseId), "--exit-status", "--interval", "5"],
		{ cwd: root, allowFailure: true });
	if (watched === null) throw new Error(`${publish ? "publish" : "validate-only"} run ${found.databaseId} failed; gh run view ${found.databaseId} --log`);
	return found.databaseId;
}

export async function release({ root = REPO_ROOT, version, publish = false, run = defaultRun,
	sleep = ms => new Promise(r => setTimeout(r, ms)), portalRelease = fetchPortalRelease, log = console.log,
	newRequestId = randomUUID } = {}) {
	const zip = gatewayZip(root, version);
	run("git", ["fetch", "--quiet", "origin", "main"], { cwd: root });
	const refusal = checkCommitted({
		relPath: zip.relPath,
		exists: existsSync(zip.path),
		localBlob: existsSync(zip.path) ? run("git", ["hash-object", zip.relPath], { cwd: root }) : null,
		mainBlob: run("git", ["rev-parse", "--verify", "--quiet", `origin/main:${zip.relPath}`], { cwd: root, allowFailure: true }),
	});
	if (refusal) throw new Error(refusal);
	const bytes = readFileSync(zip.path);
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const sha1 = createHash("sha1").update(bytes).digest("hex");
	log(`surfexp_gateways ${zip.version} sha256=${sha256}`);
	const validated = await dispatchAndWait({ run, sleep, root, version: zip.version, sha256, publish: false, newRequestId });
	log(`validate-only run ${validated}: passed`);
	if (!publish) {
		log(`publish with:\n  ${publishCommand(zip.version, sha256)}\nor rerun this tool with --publish`);
		return { version: zip.version, sha256, published: false };
	}
	const published = await dispatchAndWait({ run, sleep, root, version: zip.version, sha256, publish: true, newRequestId });
	log(`publish run ${published}: passed`);
	let portal = null;
	for (let attempt = 0; attempt < 12 && !portal; attempt++) {
		portal = await portalRelease(zip.version);
		if (!portal) await sleep(5000);
	}
	if (!portal) throw new Error(`Mod Portal does not list surfexp_gateways ${zip.version} 60s after run ${published}`);
	if (portal.sha1 !== sha1) throw new Error(`Mod Portal sha1 ${portal.sha1} does not match the local ZIP ${sha1}`);
	log(`Mod Portal lists surfexp_gateways ${zip.version} (sha1 ${sha1})`);
	return { version: zip.version, sha256, published: true };
}

async function fetchPortalRelease(version) {
	const response = await fetch(`${PORTAL}/api/mods/surfexp_gateways/full`);
	if (!response.ok) throw new Error(`Mod Portal returned ${response.status}`);
	return (await response.json()).releases.find(r => r.version === version) ?? null;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	const args = process.argv.slice(2);
	const versionAt = args.indexOf("--version");
	try {
		await release({ version: versionAt >= 0 ? args[versionAt + 1] : undefined, publish: args.includes("--publish") });
	} catch (error) {
		console.error(`release-gateway-mod: ${error.message}`);
		process.exitCode = 1;
	}
}
