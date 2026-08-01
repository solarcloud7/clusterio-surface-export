#!/usr/bin/env node
/**
 * prepare-build.mjs — the `prepare` lifecycle, guarded so an npm install cannot silently REPLACE a
 * build you already tested.
 *
 * THE MEASURED PROBLEM. `prepare` used to be a bare `npm run build`, and npm runs it on every
 * install. The container entrypoint installs the bind-mounted plugin at container CREATION, so the
 * sequence was:
 *
 *   1. deploy-cluster.ps1 builds dist/ on the host, in an isolated node:24 container, from
 *      `npm ci` — i.e. the LOCKFILE's dependency tree.
 *   2. `docker compose up -d` creates the container; its entrypoint runs `npm install`, `prepare`
 *      fires, and dist/ is rebuilt over the tested artifact.
 *   3. The entrypoint then prunes devDeps, so webpack is gone and nothing rebuilds on later restarts.
 *
 * Step 2 does NOT honour the lockfile. Measured 2026-08-01 from this cluster's own boot log: on
 * 2026-07-26 the container built with `webpack 5.108.4 compiled successfully` while
 * package-lock.json at that commit (7121da8) pinned webpack 5.105.2. The `^5.98.0` range in
 * package.json was re-resolved to whatever was newest. So the bytes that RUN were produced by a
 * different toolchain than the bytes that were built and tested, with nothing reporting the
 * difference: module-version-stamp.test.cjs and the version-stamped boot check both cover the Lua
 * module only, and lint-webpack-cache.mjs inspects the webpack CONFIG, never its output.
 *
 * THE GUARD. Build only when there is something to build:
 *   - an expected output is missing        -> build (the fresh-clone bootstrap: `docker compose up`
 *                                            on a clean checkout has no dist/ and must still work)
 *   - any source is NEWER than the outputs -> build (a stale dist/ is worse than a re-built one)
 *   - otherwise                            -> SKIP, and say so
 *
 * Freshness is compared, not merely presence: a bare "skip if dist/ exists" would trade
 * "always fresh, possibly different bytes" for "exactly the tested bytes, possibly STALE", and
 * nothing in this repo detects a stale dist/. This keeps the tested artifact AND refuses to serve an
 * outdated one.
 *
 * NOTE FOR build-plugin.ps1: it must run its build command EXPLICITLY. It used to rely on this
 * lifecycle firing during `npm ci`, which this guard can now legitimately skip.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

// Directories whose sources feed dist/. `scripts/` is deliberately absent — it holds lint guards and
// this file, none of which are compiled.
const SOURCE_DIRS = ["lib", "shared", "web"];
const SOURCE_FILES = ["package.json", "tsconfig.node.json", "tsconfig.browser.json", "webpack.config.js"];
const SOURCE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".css", ".json"];

// package-lock.json is NOT a source. The container entrypoint's own `npm install` re-stamps it on
// every boot — measured 2026-08-01: mtime 17:45:14 against package.json's 17:42:37, with byte-
// identical content and git reporting no change. Counting it as a source made this guard rebuild on
// every single boot, i.e. exactly the overwrite it exists to prevent, triggered by the installer that
// runs it. A genuine dependency change moves package.json too; and build-plugin.ps1 re-runs `npm ci`
// off this file's mtime independently, so the deploy path still reacts to a lockfile-only update.
const IGNORED_ROOT_FILES = new Set(["package-lock.json"]);

// One output per build step, so a half-finished build does not read as complete.
const OUTPUTS = [
	join(PLUGIN_DIR, "dist", "node", "index.js"),
	join(PLUGIN_DIR, "dist", "web", "manifest.json"),
];

function newestMtimeMs(path, seen = { value: 0, file: null }) {
	let entries;
	try {
		entries = readdirSync(path, { withFileTypes: true });
	} catch {
		return seen;   // a source dir that does not exist contributes nothing
	}
	for (const entry of entries) {
		if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
		const full = join(path, entry.name);
		if (entry.isDirectory()) {
			newestMtimeMs(full, seen);
			continue;
		}
		if (path === PLUGIN_DIR && IGNORED_ROOT_FILES.has(entry.name)) continue;
		if (!SOURCE_EXTS.some(ext => entry.name.endsWith(ext))) continue;
		const mtime = statSync(full).mtimeMs;
		if (mtime > seen.value) { seen.value = mtime; seen.file = full; }
	}
	return seen;
}

/** Newest mtime anywhere under dist/ — i.e. when a build last wrote anything. */
function newestBuildArtifact(path, seen) {
	let entries;
	try {
		entries = readdirSync(path, { withFileTypes: true });
	} catch {
		return seen;
	}
	for (const entry of entries) {
		const full = join(path, entry.name);
		if (entry.isDirectory()) { newestBuildArtifact(full, seen); continue; }
		const mtime = statSync(full).mtimeMs;
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
	// Plugin-root .ts files (index.ts, instance.ts, controller.ts, messages.ts, helpers.ts, ...).
	newestMtimeMs(PLUGIN_DIR, newest);
	for (const file of SOURCE_FILES) {
		const full = join(PLUGIN_DIR, file);
		if (existsSync(full)) {
			const mtime = statSync(full).mtimeMs;
			if (mtime > newest.value) { newest.value = mtime; newest.file = full; }
		}
	}

	// "When did a build last run?" = the NEWEST mtime anywhere under dist/, not the mtime of one
	// chosen output. Measured the hard way: comparing against dist/node/index.js reported "stale"
	// forever after touching shared/dto.ts, because tsc only rewrites outputs whose CONTENT changed
	// and index.js was unaffected. A per-file comparison answers "was this file regenerated", which
	// is not the question. webpack rewrites dist/web/manifest.json on every run, so the newest-in-tree
	// timestamp is a reliable last-build clock.
	const lastBuild = { value: 0, file: null };
	newestBuildArtifact(join(PLUGIN_DIR, "dist"), lastBuild);

	if (newest.value > lastBuild.value) {
		return {
			build: true,
			why: `${newest.file?.replace(PLUGIN_DIR, "")} changed after the last build `
				+ `(${lastBuild.file?.replace(PLUGIN_DIR, "") ?? "dist/"}) — dist/ is stale`,
		};
	}
	return {
		build: false,
		why: `the last build (${lastBuild.file?.replace(PLUGIN_DIR, "")}) is newer than every source `
			+ `(newest: ${newest.file?.replace(PLUGIN_DIR, "") ?? "none"})`,
	};
}

const verdict = decide();
if (!verdict.build) {
	console.log(`[prepare] SKIPPING build — ${verdict.why}.`);
	console.log("[prepare] The existing dist/ is kept deliberately: rebuilding here would replace an "
		+ "artifact that was built and tested against the LOCKFILE with one built from a re-resolved "
		+ "dependency tree. Run `npm run build` to force one.");
	process.exit(0);
}

console.log(`[prepare] building — ${verdict.why}`);
// Inherit stdio so a build failure is visible in the container boot log, and let a non-zero exit
// propagate: a failed prepare must fail the install, not leave a half-built plugin behind.
// Prefer the npm that invoked us (npm_execpath is npm-cli.js under a lifecycle script); fall back to
// PATH when run by hand.
const npmCli = process.env.npm_execpath;
if (npmCli && npmCli.endsWith(".js")) {
	execFileSync(process.execPath, [npmCli, "run", "build"], { cwd: PLUGIN_DIR, stdio: "inherit" });
} else {
	execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"],
		{ cwd: PLUGIN_DIR, stdio: "inherit" });
}
