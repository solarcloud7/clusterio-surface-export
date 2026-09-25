#!/usr/bin/env node
// seed-mods — the development cluster's third-party mod set, pinned in docker/seed-data/seed-mods.json
// requires: docker/seed-data/seed-mods.json; instance.json factorio.version pins; for fetch, FACTORIO_USERNAME and
//           FACTORIO_TOKEN in .env; for fetch and refresh, network access to mods.factorio.com
// produces: verify — exit 0 when docker/seed-data/mods holds exactly the pinned zips (sha1-checked) and the pin was
//           resolved for the instances' engine, else one line per problem and exit 1;
//           fetch — downloads missing pinned zips (sha1-checked before writing); --prune-superseded deletes other
//           versions of pinned mods;
//           refresh — rewrites the pin to each mod's latest portal release for the instances' engine
// does not: check mod-to-mod dependencies, prove a mod loads on the engine, touch surfexp_gateways zips, delete
//           unpinned mods, or print portal credentials or authenticated URLs

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT, seededInstances } from "../shared/seeded-instances.mjs";

const PORTAL = "https://mods.factorio.com";
const EXEMPT = new Set(["surfexp_gateways"]);
const ZIP_NAME = /^(.+)_(\d+\.\d+\.\d+)\.zip$/;

export function compareVersions(a, b) {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d) return Math.sign(d);
	}
	return 0;
}

export function pinPath(root = REPO_ROOT) {
	return join(root, "docker", "seed-data", "seed-mods.json");
}

export function readPin(root = REPO_ROOT) {
	return JSON.parse(readFileSync(pinPath(root), "utf8"));
}

export function instanceEngine(root = REPO_ROOT) {
	const versions = new Set(seededInstances(root).map(r => JSON.parse(readFileSync(
		join(root, "docker", "seed-data", "hosts", r.host, r.instance, "instance.json"), "utf8"))["factorio.version"]));
	if (versions.size !== 1) throw new Error(`instance.json files disagree on factorio.version: ${[...versions].join(", ")}`);
	return [...versions][0];
}

export function sha1(bytes) {
	return createHash("sha1").update(bytes).digest("hex");
}

export function checkSeedMods({ modsDir, pin, engine }) {
	const problems = [];
	if (pin.engine !== engine) {
		problems.push(`seed-mods.json was resolved for engine ${pin.engine} but instances pin ${engine}; run refresh`);
	}
	const pinned = new Map(pin.mods.map(m => [m.name, m]));
	const present = new Set();
	for (const file of readdirSync(modsDir).filter(f => f.endsWith(".zip")).sort()) {
		const match = ZIP_NAME.exec(file);
		if (!match) { problems.push(`${file}: not a name_version.zip mod file`); continue; }
		const [, name, version] = match;
		if (EXEMPT.has(name)) continue;
		const mod = pinned.get(name);
		if (!mod) { problems.push(`${file}: ${name} is not pinned in seed-mods.json`); continue; }
		if (version !== mod.version) { problems.push(`${file}: superseded, ${name} is pinned at ${mod.version}`); continue; }
		const actual = sha1(readFileSync(join(modsDir, file)));
		if (actual !== mod.sha1) problems.push(`${file}: sha1 ${actual} does not match pinned ${mod.sha1}`);
		present.add(name);
	}
	for (const mod of pin.mods) {
		if (!present.has(mod.name)) problems.push(`${mod.name}_${mod.version}.zip: pinned but missing; run fetch`);
	}
	return problems;
}

export function baseRequirement(dependencies = []) {
	for (const dep of dependencies) {
		const match = /^\s*base\s*(?:(>=|>|=)\s*(\d+(?:\.\d+)*))?\s*$/.exec(dep);
		if (match) return match[1] ? { op: match[1], version: match[2] } : null;
	}
	return null;
}

export function releaseSupports(release, engine) {
	const minor = engine.split(".").slice(0, 2).join(".");
	if (release.info_json?.factorio_version !== minor) return false;
	const req = baseRequirement(release.info_json.dependencies);
	if (!req) return true;
	const cmp = compareVersions(engine, req.version);
	return req.op === ">=" ? cmp >= 0 : req.op === ">" ? cmp > 0 : cmp === 0;
}

export function selectLatest(releases, engine) {
	const candidates = releases.filter(r => releaseSupports(r, engine));
	candidates.sort((a, b) => compareVersions(a.version, b.version));
	return candidates.at(-1) ?? null;
}

async function portalReleases(name) {
	const response = await fetch(`${PORTAL}/api/mods/${encodeURIComponent(name)}/full`);
	if (!response.ok) throw new Error(`${name}: mod portal returned ${response.status}`);
	return (await response.json()).releases;
}

function readEnv(root) {
	const values = {};
	const file = join(root, ".env");
	if (!existsSync(file)) return values;
	for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
		const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
		if (match) values[match[1]] = match[2];
	}
	return values;
}

async function fetchMods(root, pin, pruneSuperseded) {
	const modsDir = join(root, "docker", "seed-data", "mods");
	const env = readEnv(root);
	let failed = false;
	for (const mod of pin.mods) {
		const file = join(modsDir, `${mod.name}_${mod.version}.zip`);
		if (existsSync(file) && sha1(readFileSync(file)) === mod.sha1) { console.log(`present  ${mod.name} ${mod.version}`); continue; }
		if (!env.FACTORIO_USERNAME || !env.FACTORIO_TOKEN) throw new Error("FACTORIO_USERNAME and FACTORIO_TOKEN must be set in .env to fetch");
		const release = (await portalReleases(mod.name)).find(r => r.version === mod.version);
		if (!release) { console.log(`FAILED   ${mod.name} ${mod.version}: not on the mod portal`); failed = true; continue; }
		const url = new URL(release.download_url, PORTAL);
		url.searchParams.set("username", env.FACTORIO_USERNAME);
		url.searchParams.set("token", env.FACTORIO_TOKEN);
		const response = await fetch(url);
		if (!response.ok) { console.log(`FAILED   ${mod.name} ${mod.version}: download returned ${response.status}`); failed = true; continue; }
		const bytes = Buffer.from(await response.arrayBuffer());
		const actual = sha1(bytes);
		if (actual !== mod.sha1) { console.log(`FAILED   ${mod.name} ${mod.version}: sha1 ${actual} does not match pinned ${mod.sha1}`); failed = true; continue; }
		writeFileSync(`${file}.partial`, bytes);
		renameSync(`${file}.partial`, file);
		console.log(`fetched  ${mod.name} ${mod.version}`);
	}
	if (pruneSuperseded) {
		const pinned = new Map(pin.mods.map(m => [m.name, m.version]));
		for (const file of readdirSync(modsDir)) {
			const match = ZIP_NAME.exec(file);
			if (match && pinned.has(match[1]) && pinned.get(match[1]) !== match[2]) {
				rmSync(join(modsDir, file));
				console.log(`pruned   ${file}`);
			}
		}
	}
	return !failed;
}

async function refreshPin(root, pin, engine) {
	const mods = [];
	for (const mod of pin.mods) {
		const latest = selectLatest(await portalReleases(mod.name), engine);
		if (!latest) throw new Error(`${mod.name}: no portal release supports engine ${engine}`);
		if (latest.version !== mod.version) console.log(`${mod.name}: ${mod.version} -> ${latest.version}`);
		mods.push({ name: mod.name, version: latest.version, sha1: latest.sha1 });
	}
	const lines = mods.map(m => `\t\t{ "name": "${m.name}", "version": "${m.version}", "sha1": "${m.sha1}" }`);
	writeFileSync(pinPath(root), `{\n\t"engine": "${engine}",\n\t"mods": [\n${lines.join(",\n")}\n\t]\n}\n`);
	console.log(`seed-mods.json resolved for engine ${engine}`);
}

async function main(argv) {
	const [command = "verify", ...flags] = argv;
	const root = REPO_ROOT;
	const pin = readPin(root);
	const engine = instanceEngine(root);
	if (command === "verify") {
		const problems = checkSeedMods({ modsDir: join(root, "docker", "seed-data", "mods"), pin, engine });
		for (const problem of problems) console.log(`seed mods: ${problem}`);
		if (problems.length) return 1;
		console.log(`seed mods: OK (${pin.mods.length} pinned, engine ${engine})`);
		return 0;
	}
	if (command === "fetch") return (await fetchMods(root, pin, flags.includes("--prune-superseded"))) ? 0 : 1;
	if (command === "refresh") { await refreshPin(root, pin, engine); return 0; }
	console.error("usage: seed-mods.mjs [verify | fetch [--prune-superseded] | refresh]");
	return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = await main(process.argv.slice(2));
}
