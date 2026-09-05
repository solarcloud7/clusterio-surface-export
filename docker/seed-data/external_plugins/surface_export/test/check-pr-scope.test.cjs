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
		origin: "c".repeat(40), lockExit: 0, ancestorExit: 0, fetchExit: 0, ...overrides }));
	const command = `
$global:scopeResponses = Get-Content -LiteralPath $env:SCOPE_RESPONSES -Raw | ConvertFrom-Json
$global:scopeFetched = $false
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
 switch ($key) {
  'rev-parse HEAD' { $global:scopeResponses.head }
  'rev-parse --verify --quiet main^{commit}' { $global:scopeResponses.local }
  'rev-parse --verify --quiet origin/main^{commit}' { $global:scopeResponses.origin }
  'merge-base origin/main HEAD' { $global:scopeResponses.origin }
  'log --oneline origin/main..HEAD' { 'aaaaaaa fixture feature' }
  'diff --stat origin/main...HEAD' { 'fixture.txt | 1 +' }
  'diff --quiet origin/main...HEAD docker/seed-data/external_plugins/surface_export/package-lock.json' { $global:LASTEXITCODE = $global:scopeResponses.lockExit }
  'merge-base --is-ancestor origin/main HEAD' { $global:LASTEXITCODE = $global:scopeResponses.ancestorExit }
  default { throw "unexpected git call: $key" }
 }
}
& $env:SCOPE_SCRIPT
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
	assert.equal(result.calls.length, 10);
	assert.deepEqual(result.calls[1].slice(2), ["fetch", "--prune", "origin"]);
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
