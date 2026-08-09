"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SCRIPT = path.join(__dirname, "..", "scripts", "prepare-build.mjs");
const STAMP = ".prepare-build-stamp";

const madeTrees = [];
after(() => {
	for (const dir of madeTrees) fs.rmSync(dir, { recursive: true, force: true });
});

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
	setMtime(path.join(dir, "lib", "a.ts"), T(60));
	setMtime(path.join(dir, "web", "b.tsx"), T(60));
	stamp(dir, "node");
	stamp(dir, "web", T(90));
	const v = decide(dir);
	assert.equal(v.build, true,
		"a partial build must NOT mask its stale sibling: the newest-across-all-of-dist clock took the "
		+ `fresh node stamp and dist/web never rebuilt (got: ${JSON.stringify(v)})`);

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

	setMtime(path.join(dir, "lib", "a.ts"), T(30));
	assert.equal(decide(dir).build, true, "a newer source must rebuild");

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
