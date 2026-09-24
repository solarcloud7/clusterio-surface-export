"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

const script = path.resolve(__dirname, "..", "..", "..", "..", "..", "tools", "check-pr-scope.ps1");
const toolSkip = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"],
	{ stdio: "ignore" }).status === 0 ? false : "requires pwsh";

function run(t, overrides = {}) {
	const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "check-pr-scope-")));
	assert.ok(root.startsWith(realpathSync.native(tmpdir()) + path.sep));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const config = path.join(root, "responses.json");
	const calls = path.join(root, "calls.jsonl");
	writeFileSync(config, JSON.stringify({ root, head: "a".repeat(40), local: "b".repeat(40),
		origin: "c".repeat(40), lockExit: 0, ancestorExit: 0, fetchExit: 0, base: "main", pr: null, baseArg: null,
		originMissing: false, ...overrides }));
	const command = `
$global:scopeResponses = Get-Content -LiteralPath $env:SCOPE_RESPONSES -Raw | ConvertFrom-Json
$global:scopeFetched = $false
function global:gh {
 ConvertTo-Json -InputObject (@('gh') + @($args)) -Compress | Add-Content -LiteralPath $env:SCOPE_CALLS
 if (-not $global:scopeFetched) { throw 'pull request base was read before fetching origin' }
 if (($args -join ' ') -ne 'pr view --json number,baseRefName') { throw "unexpected gh call: $args" }
 if ($global:scopeResponses.pr) {
  $global:LASTEXITCODE = 0
  ConvertTo-Json -InputObject @{ number = 7; baseRefName = $global:scopeResponses.pr } -Compress
 } else {
  $global:LASTEXITCODE = 1
  'no pull requests found for branch "fixture"'
 }
}
function global:git {
 $arguments = @($args)
 ConvertTo-Json -InputObject $arguments -Compress | Add-Content -LiteralPath $env:SCOPE_CALLS
 if ($arguments[0] -eq '-C') {
  if ($arguments[1] -ne $global:scopeResponses.root) { throw 'wrong repository argument' }
  $arguments = @($arguments | Select-Object -Skip 2)
 }
 $key = $arguments -join ' '
 $global:LASTEXITCODE = 0
 switch ($key) {
  'rev-parse --show-toplevel' { $global:scopeResponses.root; return }
  'fetch --prune origin' {
   $global:scopeFetched = $true
   $global:LASTEXITCODE = $global:scopeResponses.fetchExit
   if ($global:LASTEXITCODE) { 'fixture fetch failure' }
   return
  }
 }
 if (-not $global:scopeFetched) { throw 'scope was read before fetching origin' }
 $local = $global:scopeResponses.base
 $base = "origin/$local"
 switch ($key) {
  'rev-parse HEAD' { $global:scopeResponses.head }
  "rev-parse --verify --quiet $local^{commit}" { $global:scopeResponses.local }
  "rev-parse --verify --quiet $base^{commit}" {
   if ($global:scopeResponses.originMissing) { $global:LASTEXITCODE = 1 } else { $global:scopeResponses.origin }
  }
  "merge-base $base HEAD" { $global:scopeResponses.origin }
  "log --oneline $base..HEAD" { 'aaaaaaa fixture feature' }
  "diff --stat $base...HEAD" { 'fixture.txt | 1 +' }
  "diff --quiet $base...HEAD docker/seed-data/external_plugins/surface_export/package-lock.json" { $global:LASTEXITCODE = $global:scopeResponses.lockExit }
  "merge-base --is-ancestor $base HEAD" { $global:LASTEXITCODE = $global:scopeResponses.ancestorExit }
  default { throw "unexpected git call: $key" }
 }
}
$scopeArguments = @{}
if ($global:scopeResponses.baseArg) { $scopeArguments.Base = $global:scopeResponses.baseArg }
& $env:SCOPE_SCRIPT @scopeArguments
exit $LASTEXITCODE
`;
	const result = spawnSync("pwsh", ["-NoProfile", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")],
		{ cwd: root, encoding: "utf8", timeout: 15000,
			env: { ...process.env, SCOPE_RESPONSES: config, SCOPE_CALLS: calls, SCOPE_SCRIPT: script } });
	assert.equal(existsSync(path.join(root, ".git")), false);
	return { ...result, calls: readFileSync(calls, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line)) };
}

test("scope check reports freshly fetched refs and invokes only its read/fetch commands", { skip: toolSkip }, t => {
	const result = run(t);
	assert.equal(result.status, 0, result.stderr || result.stdout);
	assert.match(result.stdout, /Local main:\s+b{40}/);
	assert.match(result.stdout, /Origin main:\s+c{40}/);
	assert.match(result.stdout, /Merge base:\s+c{40}/);
	assert.match(result.stdout, /package-lock\.json differs:\s+no/i);
	assert.match(result.stdout, /Scope check: PASS/);
	assert.match(result.stdout, /Base:\s+origin\/main \(default; no pull request for this branch: no pull requests found/);
	assert.equal(result.calls.length, 11);
	assert.deepEqual(result.calls[1].slice(2), ["fetch", "--prune", "origin"]);
	assert.deepEqual(result.calls[2], ["gh", "pr", "view", "--json", "number,baseRefName"]);
});

test("scope check compares a stacked branch with its pull request's base", { skip: toolSkip }, t => {
	const result = run(t, { pr: "codex/factorio-2-1-20", base: "codex/factorio-2-1-20" });
	assert.equal(result.status, 0, result.stderr || result.stdout);
	assert.match(result.stdout, /Base:\s+origin\/codex\/factorio-2-1-20 \(pull request #7\)/);
	assert.match(result.stdout, /Local codex\/factorio-2-1-20:\s+b{40}/);
	assert.match(result.stdout, /Commits in origin\/codex\/factorio-2-1-20\.\.HEAD:/);
	assert.match(result.stdout, /Scope check: PASS - origin\/codex\/factorio-2-1-20 is an ancestor of HEAD/);
	assert.equal(result.calls.filter(call => call.some(arg => /origin\/main/.test(arg))).length, 0);
});

test("scope check reports a stacked branch that its base has moved past", { skip: toolSkip }, t => {
	const result = run(t, { pr: "codex/factorio-2-1-20", base: "codex/factorio-2-1-20", ancestorExit: 1 });
	assert.equal(result.status, 1, result.stderr || result.stdout);
	assert.match(result.stderr, /origin\/codex\/factorio-2-1-20 is not an ancestor of HEAD/);
});

test("an explicit base wins over the pull request and skips the GitHub lookup", { skip: toolSkip }, t => {
	const result = run(t, { baseArg: "origin/release", pr: "codex/other", base: "release" });
	assert.equal(result.status, 0, result.stderr || result.stdout);
	assert.match(result.stdout, /Base:\s+origin\/release \(given with -Base\)/);
	assert.equal(result.calls.filter(call => call[0] === "gh").length, 0);
});

test("scope check exits 2 when the base is missing on origin", { skip: toolSkip }, t => {
	const result = run(t, { pr: "retired-base", base: "retired-base", originMissing: true });
	assert.equal(result.status, 2, result.stderr || result.stdout);
	assert.match(result.stderr, /Scope check: ERROR - origin\/retired-base is missing after git fetch --prune origin/);
	assert.doesNotMatch(result.stdout, /Scope check: PASS/);
});

test("scope check fails when freshly fetched origin main is not an ancestor of HEAD", { skip: toolSkip }, t => {
	const result = run(t, { ancestorExit: 1 });
	assert.equal(result.status, 1, result.stderr || result.stdout);
	assert.match(result.stderr, /origin\/main is not an ancestor of HEAD/);
	assert.doesNotMatch(result.stderr, /At .*check-pr-scope\.ps1:/);
});

test("scope check reports a package-lock difference without treating it as an ancestry failure", { skip: toolSkip }, t => {
	const result = run(t, { lockExit: 1 });
	assert.equal(result.status, 0, result.stderr || result.stdout);
	assert.match(result.stdout, /package-lock\.json differs:\s+YES/);
});

test("scope check exits 2 with a clean message when origin cannot be fetched", { skip: toolSkip }, t => {
	const result = run(t, { fetchExit: 128 });
	assert.equal(result.status, 2, result.stderr || result.stdout);
	assert.match(result.stderr, /Scope check: ERROR - git [\s\S]*fetch --prune origin failed:/);
	assert.equal(result.calls.length, 2);
});

test("scope check distinguishes Git command errors from ancestry and lock differences", { skip: toolSkip }, t => {
	for (const overrides of [{ ancestorExit: 128 }, { lockExit: 128 }]) {
		const result = run(t, overrides);
		assert.equal(result.status, 2, result.stderr || result.stdout);
		assert.match(result.stderr, /Scope check: ERROR/);
		assert.doesNotMatch(result.stdout, /Scope check: PASS/);
	}
});
