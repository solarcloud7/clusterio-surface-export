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
import { readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Test seam: the purpose-invariant tests (test/prepare-build.invariant.test.cjs) drive this script
// against a TEMP tree via the env override + `--decide` (prints the verdict as JSON, executes
// nothing). Production never sets the variable, so the real plugin dir stays the default.
const PLUGIN_DIR = process.env.PREPARE_BUILD_PLUGIN_DIR
	? resolve(process.env.PREPARE_BUILD_PLUGIN_DIR)
	: join(dirname(fileURLToPath(import.meta.url)), "..");

// --- The build clock -----------------------------------------------------------------------------
//
// Each output tree carries a stamp file written by its OWN build script's `post` hook
// (`postbuild:node` / `postbuild:web` in package.json), so the clock records "this tree was built at
// T" regardless of what the compiler chose to write.
//
// mtimes of the artifacts themselves cannot do this job, and both ways of trying failed in review:
//   - one chosen file (dist/node/index.js): tsc only rewrites outputs whose CONTENT changed, so
//     editing shared/dto.ts left index.js untouched and the guard said "stale" forever.
//   - newest mtime in the tree: `tsc --incremental` writes NOTHING AT ALL when its tsbuildinfo is
//     already current, so a full successful build can leave every mtime in dist/node unchanged and
//     the guard reports stale forever — measured.
// A stamp written by the build is the only signal that means what it says.
const STAMP = ".prepare-build-stamp";

/** `--stamp <tree>` mode: record that this output tree was just built. */
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

// Directories whose sources feed dist/. `scripts/` is deliberately absent — it holds lint guards and
// this file, none of which are compiled.
const SOURCE_DIRS = ["lib", "shared", "web"];
// Build CONFIG that is not rewritten by the deploy. package.json is deliberately absent — see
// IGNORED_ROOT_FILES; listing it here would silently re-admit it past that exclusion.
const SOURCE_FILES = ["tsconfig.node.json", "tsconfig.browser.json", "webpack.config.js"];
const SOURCE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".css", ".json"];

// Files this repo's own tooling rewrites on every deploy are NOT sources. Counting them made the
// guard fire on its own infrastructure — the failure mode being that a false "stale" verdict causes
// the very live-directory rebuild this guard exists to prevent.
//
//   package-lock.json  the container entrypoint's `npm install` re-stamps it on every boot.
//                      Measured 2026-08-01: mtime 17:45:14 vs package.json's 17:42:37, content
//                      byte-identical, git clean. A genuine dependency change also moves
//                      package.json, and build-plugin.ps1 re-runs `npm ci` off this file's mtime
//                      independently, so the deploy path still reacts to a lockfile-only update.
//   package.json       deploy.ps1 bumps the version on every run. Critically, `-Scope lua` bumps it
//                      and then SKIPS the build by design — so counting it here left dist/ "stale"
//                      on a routine documented path, and the following host restart rebuilt it
//                      INSIDE the live bind-mounted plugin dir with the image's own devDeps: exactly
//                      the wrong-toolchain overwrite this file was written to stop, triggered by the
//                      deploy script's own version bump. Found in review.
//
// This is not a new judgement call: patch-and-reset.ps1's staleness tripwire (:73-79) already
// excludes both files for the same reason, recorded there as a review-caught defect. Two detectors
// disagreeing about what counts as a source is worse than either rule.
const IGNORED_ROOT_FILES = new Set(["package-lock.json", "package.json"]);

// One output per build step, so a half-finished build does not read as complete.
const OUTPUTS = [
	join(PLUGIN_DIR, "dist", "node", "index.js"),
	join(PLUGIN_DIR, "dist", "web", "manifest.json"),
];

function newestMtimeMs(path, seen = { value: 0, file: null }, { recurse = true } = {}) {
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
			// The plugin-root scan is NON-RECURSIVE. A recursive walk here swept `scripts/`,
			// `module/` and `test/` back in via their .json/.js files — so touching a lint-allow
			// manifest, or the version stamp this repo's own deploy rewrites every run, forced a full
			// rebuild at container boot. patch-and-reset.ps1:73-79 records that exact defect being
			// review-rejected in its own staleness detector; this file reproduced it.
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

/**
 * Newest mtime under ONE output tree — i.e. when that tree was last written.
 *
 * Files dated in the FUTURE are ignored. A single future-dated artifact (bind-mount clock skew
 * between the Docker VM and the Windows host after a sleep/resume) would otherwise pin the clock
 * ahead and skip every build until the host caught up.
 */
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
	// Plugin-root .ts files (index.ts, instance.ts, controller.ts, messages.ts, helpers.ts, ...) —
	// this level ONLY, never descending. See newestMtimeMs.
	newestMtimeMs(PLUGIN_DIR, newest, { recurse: false });
	for (const file of SOURCE_FILES) {
		const full = join(PLUGIN_DIR, file);
		if (existsSync(full)) {
			const mtime = statSync(full).mtimeMs;
			if (mtime > newest.value) { newest.value = mtime; newest.file = full; }
		}
	}

	// "When did a build last run?" is asked PER OUTPUT TREE, and the answer taken is the OLDEST.
	//
	// Two mistakes are baked out here. First: comparing against one chosen file (dist/node/index.js)
	// reported "stale" forever after touching shared/dto.ts, because tsc only rewrites outputs whose
	// CONTENT changed. A per-file comparison answers "was this file regenerated", which is not the
	// question. Second, and worse: taking the newest mtime across ALL of dist/ let a PARTIAL build
	// mask a stale sibling. build-plugin.ps1 supports `-Target node`, which writes dist/node only —
	// that advanced the single shared clock past web sources, and dist/web then never rebuilt at all.
	// The old `prepare` self-healed this by always doing a full build; this guard removed that safety
	// net and has to replace it. Both found in review.
	//
	// Taking the MIN means every tree must be newer than every source, so a partial build leaves the
	// guard correctly reporting stale. It errs toward building, which is the safe direction: a
	// needless rebuild costs seconds, a wrong skip ships stale code.
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
		// No stamp = built before this mechanism existed, or built by something that bypassed the
		// npm scripts. Build rather than guess; the stamp then exists for every run after.
		return { build: true, why: `no build stamp for ${unstamped.map(t => `dist/${t.name}`).join(", ")}` };
	}
	const lastBuild = trees.reduce((a, b) => (b.value < a.value ? b : a));

	// `>=`, not `>`: equal mtimes must rebuild. Coarse (1-second) mtime granularity on a bind mount
	// can stamp an edit and the build that followed it identically, and "equal" is not "newer".
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
// `--decide` reports the verdict without acting on it (the invariant tests' observation channel).
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
