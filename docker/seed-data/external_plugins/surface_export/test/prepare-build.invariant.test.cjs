"use strict";
/**
 * Purpose-invariant tests for scripts/prepare-build.mjs — the build-staleness guard shipped with NO
 * test file, and its load-bearing part (the MIN-of-stamps clock) ran nowhere (Workstream A item 2).
 *
 * The invariant, stated over the guard's OUTPUT (its verdict), never its implementation:
 *   - a fully built tree (every stamp newer than every source) SKIPS,
 *     even when the artifact files themselves are old (tsc legitimately rewrites nothing);
 *   - building ONE tree does not un-stale the OTHER (the clock is the MIN of the stamps);
 *   - any source edit after a full build makes it stale again, and EQUAL mtimes count as stale
 *     (1-second bind-mount granularity can stamp an edit and its build identically).
 *
 * Teeth against both historical buggy clocks (each shipped, each review-caught):
 *   - "newest mtime across ALL of dist/" passes the full-build test but FAILS the MIN test
 *     (a node-only build advanced the shared clock past web sources; dist/web never rebuilt);
 *   - "one chosen artifact file's mtime" passes the MIN test but FAILS the full-build test
 *     (tsc leaves content-unchanged outputs untouched, so it read "stale" forever).
 *
 * Driven as a CHILD PROCESS against a temp tree via the PREPARE_BUILD_PLUGIN_DIR seam and
 * `--decide` (verdict as JSON, executes nothing). Zero deps: node:test only.
 */

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SCRIPT = path.join(__dirname, "..", "scripts", "prepare-build.mjs");
const STAMP = ".prepare-build-stamp";

// Zero-leftover discipline applies to temp trees too (review finding: four mkdtemp trees leaked
// per run). Every tree is tracked and removed after the file's tests complete, pass or fail.
const madeTrees = [];
after(() => {
	for (const dir of madeTrees) fs.rmSync(dir, { recursive: true, force: true });
});

/** Minimal plugin shape: one source feeding each tree, both expected outputs present. */
function makeTree() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prepare-build-inv-"));
	madeTrees.push(dir);
	fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
	fs.mkdirSync(path.join(dir, "web"), { recursive: true });
	fs.mkdirSync(path.join(dir, "dist", "node"), { recursive: true });
	fs.mkdirSync(path.join(dir, "dist", "web"), { recursive: true });
	fs.writeFileSync(path.join(dir, "lib", "a.ts"), "// src\n");
	fs.writeFileSync(path.join(dir, "web", "b.tsx"), "// src\n");
	fs.writeFileSync(path.join(dir, "dist", "node", "index.js"), "// out\n");
	fs.writeFileSync(path.join(dir, "dist", "web", "manifest.json"), "{}\n");
	return dir;
}

function run(dir, ...args) {
	return execFileSync(process.execPath, [SCRIPT, ...args], {
		env: { ...process.env, PREPARE_BUILD_PLUGIN_DIR: dir },
		encoding: "utf8",
	});
}
const decide = (dir) => JSON.parse(run(dir, "--decide"));
function stamp(dir, tree, whenMs) {
	run(dir, "--stamp", tree);
	if (whenMs !== undefined) {
		fs.utimesSync(path.join(dir, "dist", tree, STAMP), whenMs / 1000, whenMs / 1000);
	}
}
const setMtime = (file, whenMs) => fs.utimesSync(file, whenMs / 1000, whenMs / 1000);

const NOW = Date.now();
const T = (secondsAgo) => NOW - secondsAgo * 1000;

test("unstamped trees BUILD; a full build SKIPS even when the artifact files are old", () => {
	const dir = makeTree();
	assert.equal(decide(dir).build, true,
		"no stamps -> build: a dist/ from before the stamp mechanism (or from a bypassing builder) must not be trusted");

	// Sources firmly in the past; artifacts even older (tsc wrote nothing content-unchanged);
	// stamps now. The verdict must come from the STAMPS - a chosen-artifact clock reads stale here.
	setMtime(path.join(dir, "lib", "a.ts"), T(300));
	setMtime(path.join(dir, "web", "b.tsx"), T(300));
	setMtime(path.join(dir, "dist", "node", "index.js"), T(600));
	setMtime(path.join(dir, "dist", "web", "manifest.json"), T(600));
	stamp(dir, "node");
	stamp(dir, "web");
	const v = decide(dir);
	assert.equal(v.build, false,
		`a fully built, fully stamped tree must SKIP regardless of artifact mtimes (got: ${v.why})`);
});

test("MIN-of-stamps: building ONE tree does not un-stale the OTHER", () => {
	const dir = makeTree();
	// Both sources edited at T-60. Web was last built BEFORE that edit (T-90); node was just built.
	setMtime(path.join(dir, "lib", "a.ts"), T(60));
	setMtime(path.join(dir, "web", "b.tsx"), T(60));
	stamp(dir, "node");
	stamp(dir, "web", T(90));
	const v = decide(dir);
	assert.equal(v.build, true,
		"a partial build must NOT mask its stale sibling: the newest-across-all-of-dist clock took the "
		+ `fresh node stamp and dist/web never rebuilt (got: ${JSON.stringify(v)})`);

	// Completing the build (web now stamped after its sources) flips the verdict to SKIP.
	stamp(dir, "web");
	assert.equal(decide(dir).build, false, "both trees now newer than every source -> skip");
});

test("a source edit after a full build is stale again; EQUAL mtimes are stale", () => {
	const dir = makeTree();
	setMtime(path.join(dir, "lib", "a.ts"), T(120));
	setMtime(path.join(dir, "web", "b.tsx"), T(120));
	stamp(dir, "node", T(60));
	stamp(dir, "web", T(60));
	assert.equal(decide(dir).build, false, "baseline: fully built -> skip");

	// Edit lands AFTER the build.
	setMtime(path.join(dir, "lib", "a.ts"), T(30));
	assert.equal(decide(dir).build, true, "a newer source must rebuild");

	// Edit lands at the SAME second as the build (bind-mount 1s granularity): equal is not newer.
	setMtime(path.join(dir, "lib", "a.ts"), T(60));
	assert.equal(decide(dir).build, true,
		"an mtime EQUAL to the build stamp must rebuild - coarse timestamps make 'equal' ambiguous, "
		+ "and the safe direction is building");
});

test("a missing output forces a build regardless of stamps (fresh-clone bootstrap)", () => {
	const dir = makeTree();
	stamp(dir, "node");
	stamp(dir, "web");
	fs.rmSync(path.join(dir, "dist", "web", "manifest.json"));
	const v = decide(dir);
	assert.equal(v.build, true, "a missing expected output must build even with fresh stamps");
	assert.match(String(v.why), /missing/);
});
