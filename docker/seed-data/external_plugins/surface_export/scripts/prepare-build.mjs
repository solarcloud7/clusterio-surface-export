#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = process.env.PREPARE_BUILD_PLUGIN_DIR
	? resolve(process.env.PREPARE_BUILD_PLUGIN_DIR)
	: join(dirname(fileURLToPath(import.meta.url)), "..");

const STAMP = ".prepare-build-stamp";

function stampTree(tree) {
	const dir = join(PLUGIN_DIR, "dist", tree);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, STAMP), `${new Date().toISOString()}\n`);
}

const stampArg = process.argv.indexOf("--stamp");
if (stampArg !== -1) {
	const tree = process.argv[stampArg + 1];
	if (!tree) { console.error("prepare-build --stamp needs a tree name (node|web)"); process.exit(2); }
	stampTree(tree);
	process.exit(0);
}

const SOURCE_DIRS = ["lib", "shared", "web"];
const SOURCE_FILES = ["tsconfig.node.json", "tsconfig.browser.json", "webpack.config.js"];
const SOURCE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".css", ".json"];

const IGNORED_ROOT_FILES = new Set(["package-lock.json", "package.json"]);

const OUTPUTS = [
	join(PLUGIN_DIR, "dist", "node", "index.js"),
	join(PLUGIN_DIR, "dist", "web", "manifest.json"),
];

function newestMtimeMs(path, seen = { value: 0, file: null }, { recurse = true } = {}) {
	let entries;
	try {
		entries = readdirSync(path, { withFileTypes: true });
	} catch {
		return seen;
	}
	for (const entry of entries) {
		if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
		const full = join(path, entry.name);
		if (entry.isDirectory()) {
			if (recurse) newestMtimeMs(full, seen);
			continue;
		}
		if (path === PLUGIN_DIR && IGNORED_ROOT_FILES.has(entry.name)) continue;
		if (!SOURCE_EXTS.some(ext => entry.name.endsWith(ext))) continue;
		const mtime = statSync(full).mtimeMs;
		if (mtime > seen.value) { seen.value = mtime; seen.file = full; }
	}
	return seen;
}

function newestBuildArtifact(path, seen = { value: 0, file: null }, now = Date.now()) {
	let entries;
	try {
		entries = readdirSync(path, { withFileTypes: true });
	} catch {
		return seen;
	}
	for (const entry of entries) {
		const full = join(path, entry.name);
		if (entry.isDirectory()) { newestBuildArtifact(full, seen, now); continue; }
		const mtime = statSync(full).mtimeMs;
		if (mtime > now) continue;
		if (mtime > seen.value) { seen.value = mtime; seen.file = full; }
	}
	return seen;
}

function decide() {
	const missing = OUTPUTS.filter(output => !existsSync(output));
	if (missing.length) {
		return { build: true, why: `missing build output: ${missing.map(m => m.replace(PLUGIN_DIR, "")).join(", ")}` };
	}

	const newest = { value: 0, file: null };
	for (const dir of SOURCE_DIRS) newestMtimeMs(join(PLUGIN_DIR, dir), newest);
	newestMtimeMs(PLUGIN_DIR, newest, { recurse: false });
	for (const file of SOURCE_FILES) {
		const full = join(PLUGIN_DIR, file);
		if (existsSync(full)) {
			const mtime = statSync(full).mtimeMs;
			if (mtime > newest.value) { newest.value = mtime; newest.file = full; }
		}
	}

	const trees = ["node", "web"].map(name => {
		const stamp = join(PLUGIN_DIR, "dist", name, STAMP);
		return {
			name,
			value: existsSync(stamp) ? statSync(stamp).mtimeMs : 0,
			file: existsSync(stamp) ? stamp : null,
		};
	});
	const unstamped = trees.filter(tree => tree.value === 0);
	if (unstamped.length) {
		return { build: true, why: `no build stamp for ${unstamped.map(t => `dist/${t.name}`).join(", ")}` };
	}
	const lastBuild = trees.reduce((a, b) => (b.value < a.value ? b : a));

	if (newest.value >= lastBuild.value) {
		return {
			build: true,
			why: `${newest.file?.replace(PLUGIN_DIR, "")} is not older than the last dist/${lastBuild.name} `
				+ "build — stale",
		};
	}
	return {
		build: false,
		why: `every output tree (${trees.map(t => `dist/${t.name}`).join(", ")}) was built after every `
			+ `source (newest: ${newest.file?.replace(PLUGIN_DIR, "") ?? "none"})`,
	};
}

const verdict = decide();
if (process.argv.includes("--decide")) {
	console.log(JSON.stringify(verdict));
	process.exit(0);
}
if (!verdict.build) {
	console.log(`[prepare] SKIPPING build — ${verdict.why}.`);
	console.log("[prepare] The existing dist/ is kept deliberately: rebuilding here would replace an "
		+ "artifact that was built and tested against the LOCKFILE with one built from a re-resolved "
		+ "dependency tree. Run `npm run build` to force one.");
	process.exit(0);
}

console.log(`[prepare] building — ${verdict.why}`);
const npmCli = process.env.npm_execpath;
if (npmCli && npmCli.endsWith(".js")) {
	execFileSync(process.execPath, [npmCli, "run", "build"], { cwd: PLUGIN_DIR, stdio: "inherit" });
} else {
	execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"],
		{ cwd: PLUGIN_DIR, stdio: "inherit" });
}
