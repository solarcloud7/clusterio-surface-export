"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

const script = path.resolve(__dirname, "..", "..", "..", "..", "..", "tools", "check-pr-scope.ps1");
const requiredToolsAvailable = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0
	&& spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], { stdio: "ignore" }).status === 0;
const toolSkip = requiredToolsAvailable ? false : "requires git and pwsh";

function git(cwd, ...args) {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function createFixture() {
	const root = mkdtempSync(path.join(tmpdir(), "check-pr-scope-"));
	const remote = path.join(root, "origin.git");
	const repo = path.join(root, "repo");
	mkdirSync(repo);
	git(root, "init", "--bare", remote);
	git(repo, "init", "-b", "main");
	git(repo, "config", "user.email", "scope-test@example.invalid");
	git(repo, "config", "user.name", "Scope Test");
	writeFileSync(path.join(repo, "README.md"), "base\n");
	mkdirSync(path.join(repo, "docker", "seed-data", "external_plugins", "surface_export"), { recursive: true });
	writeFileSync(path.join(repo, "docker", "seed-data", "external_plugins", "surface_export", "package-lock.json"), "{}\n");
	git(repo, "add", ".");
	git(repo, "commit", "-m", "chore: seed");
	git(repo, "remote", "add", "origin", remote);
	git(repo, "push", "-u", "origin", "main");
	return { repo };
}

function run(repo) {
	return spawnSync("pwsh", ["-NoProfile", "-File", script], { cwd: repo, encoding: "utf8" });
}

test("scope check reports a fresh descendant branch without changing the working tree", { skip: toolSkip }, () => {
	const { repo } = createFixture();
	git(repo, "switch", "-c", "codex/feature");
	writeFileSync(path.join(repo, "feature.txt"), "feature\n");
	git(repo, "add", "feature.txt");
	git(repo, "commit", "-m", "feat: add feature");
	const before = git(repo, "status", "--porcelain=v1");

	const result = run(repo);

	assert.equal(result.status, 0, result.stderr || result.stdout);
	assert.match(result.stdout, /Local main:\s+[0-9a-f]{7,40}/);
	assert.match(result.stdout, /Origin main:\s+[0-9a-f]{7,40}/);
	assert.match(result.stdout, /Merge base:\s+[0-9a-f]{7,40}/);
	assert.match(result.stdout, /package-lock\.json differs:\s+no/i);
	assert.match(result.stdout, /Scope check: PASS/);
	assert.equal(git(repo, "status", "--porcelain=v1"), before);
});

test("scope check fails when freshly fetched origin main is not an ancestor of HEAD", { skip: toolSkip }, () => {
	const { repo } = createFixture();
	git(repo, "switch", "-c", "codex/stale");
	writeFileSync(path.join(repo, "stale.txt"), "stale\n");
	git(repo, "add", "stale.txt");
	git(repo, "commit", "-m", "feat: stale branch");
	git(repo, "switch", "main");
	writeFileSync(path.join(repo, "main.txt"), "advanced\n");
	git(repo, "add", "main.txt");
	git(repo, "commit", "-m", "feat: advance main");
	git(repo, "push", "origin", "main");
	git(repo, "switch", "codex/stale");

	const result = run(repo);

	assert.equal(result.status, 1, result.stderr || result.stdout);
	const output = `${result.stdout}\n${result.stderr}`;
	assert.match(output, /origin\/main is not an ancestor of HEAD/);
	assert.doesNotMatch(output, /At .*check-pr-scope\.ps1:/);
});

test("scope check reports a package-lock difference without treating it as an ancestry failure", { skip: toolSkip }, () => {
	const { repo } = createFixture();
	git(repo, "switch", "-c", "codex/dependency-shape");
	const lock = path.join(repo, "docker", "seed-data", "external_plugins", "surface_export", "package-lock.json");
	writeFileSync(lock, "{\"changed\":true}\n");
	git(repo, "add", lock);
	git(repo, "commit", "-m", "test: change lockfile");

	const result = run(repo);

	assert.equal(result.status, 0, result.stderr || result.stdout);
	assert.match(result.stdout, /package-lock\.json differs:\s+YES/);
});
test("scope check exits 2 with a clean message when origin cannot be fetched", { skip: toolSkip }, () => {
	const { repo } = createFixture();
	git(repo, "remote", "remove", "origin");

	const result = run(repo);
	const output = `${result.stdout}\n${result.stderr}`;

	assert.equal(result.status, 2, output);
	assert.match(output, /Scope check: ERROR - git [\s\S]*fetch --prune origin failed:/);
	assert.doesNotMatch(output, /At .*check-pr-scope\.ps1:/);
});
