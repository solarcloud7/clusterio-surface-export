import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repo = realpathSync.native(fileURLToPath(new URL("../../", import.meta.url)));
const script = join(repo, "tools", "clusterio", "build-plugin.ps1");
const skip = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"],
	{ stdio: "ignore" }).status === 0 ? false : "requires pwsh";

function run(t, target, fail = false, options = {}) {
	const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "build-plugin-mount-")));
	assert.ok(dir.startsWith(realpathSync.native(tmpdir()) + sep));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const calls = join(dir, "calls.jsonl");
	writeFileSync(calls, "");
const command = `
if ($env:BUILD_FAIL_CLEANUP -eq 'true') {
 function global:Remove-Item {
  param($LiteralPath, [switch]$Force, $ErrorAction)
  if ([IO.Path]::GetFileName($LiteralPath) -like 'se-build-lock-*') { throw 'injected cleanup sharing violation' }
  Microsoft.PowerShell.Management\\Remove-Item -LiteralPath $LiteralPath -Force:$Force -ErrorAction Stop
 }
}
function global:git {
 $call = $args -join ' '
 $global:LASTEXITCODE = 0
 if ($call -match 'rev-parse --abbrev-ref HEAD$') { return 'fixture-branch' }
 if ($call -match 'rev-parse --short=12 HEAD$') { return 'fixturecommit' }
 if ($call -notmatch 'rev-parse --path-format=absolute --git-dir --git-common-dir$') { throw "unexpected git call: $call" }
 if ($env:BUILD_LINKED -eq 'true') { '/fixture/.git/worktrees/other'; '/fixture/.git' } else { '/fixture/.git'; '/fixture/.git' }
}
function global:docker {
 $arguments = @($args)
 ConvertTo-Json -InputObject $arguments -Compress | Add-Content -LiteralPath $env:BUILD_CALLS
 $global:LASTEXITCODE = 0
 switch ($arguments[0]) {
  'ps' { "surface-export-controller|$env:BUILD_CLUSTER_ROOT" }
  'version' { 'fixture server' }
  'run' {
   if ($env:BUILD_MUTATE_LOCK) {
    $snapshot = ($arguments | Where-Object { $_ -like '*package-lock.json,readonly' }) -replace '^type=bind,src=','' -replace ',dst=.*$',''
    [IO.File]::ReadAllText($snapshot) | Set-Content -LiteralPath ($env:BUILD_CALLS + '.snapshot')
    [IO.File]::WriteAllText($env:BUILD_MUTATE_LOCK,'changed-while-building')
   }
   if ($env:BUILD_FAIL -eq 'true') { $global:LASTEXITCODE = 5 }
  }
  default { throw 'unexpected Docker operation' }
 }
}
if ($env:BUILD_FAIL -eq 'true') {
 & $env:BUILD_SCRIPT $env:BUILD_TARGET -RestartController -RestartHosts
} else {
 $extra = @{}
 if ($env:BUILD_PACKAGE) { $extra.PackageDirectory = $env:BUILD_PACKAGE; $extra.OutputDirectory = $env:BUILD_OUTPUT }
 if ($env:BUILD_RESTART -eq 'true') { $extra.RestartController = $true; $extra.RestartHosts = $true }
 & $env:BUILD_SCRIPT $env:BUILD_TARGET @extra
}
exit $LASTEXITCODE
`;
	const result = spawnSync("pwsh", ["-NoProfile", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")],
		{ encoding: "utf8", timeout: 15000, cwd: options.cwd, env: { ...process.env,
			BUILD_LINKED: String(options.linked || false), BUILD_RESTART: String(options.restart || false),
			BUILD_CLUSTER_ROOT: options.clusterRoot || repo,
			BUILD_SCRIPT: script, BUILD_TARGET: target, BUILD_PACKAGE: options.packageDirectory || "",
			BUILD_MUTATE_LOCK: options.mutateLock || "",
			BUILD_FAIL_CLEANUP: String(options.failCleanup || false),
			BUILD_OUTPUT: options.outputDirectory || "", BUILD_CALLS: calls, BUILD_FAIL: String(fail) } });
	return { ...result, snapshot: existsSync(`${calls}.snapshot`) ? readFileSync(`${calls}.snapshot`, "utf8").trim() : null,
		calls: readFileSync(calls, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse) };
}

test("lint and unit tests see the full checkout with isolated plugin dependencies", { skip }, t => {
	for (const target of ["lint", "test", "smoke"]) {
		const result = run(t, target);
		assert.equal(result.status, 0, result.stderr || result.stdout);
		assert.deepEqual(result.calls.map(args => args[0]), ["version", "run"]);
		const args = result.calls[1];
		assert.equal(args[args.indexOf("--mount") + 1], `type=bind,src=${repo},dst=/repo`);
		assert.equal(args[args.indexOf("-w") + 1], "/repo/docker/seed-data/external_plugins/surface_export");
		assert.equal(args[args.indexOf("-v") + 1], "se_plugin_build_nm:/repo/docker/seed-data/external_plugins/surface_export/node_modules");
		assert.ok(args.includes("node:24-bookworm-slim"));
		assert.ok(args.at(-1).includes(target === "test" ? "npm test" : target === "smoke" ? "npm run test:lifecycle" : "npm run lint"));
		const snapshot = args.find(value => value.endsWith("package-lock.json,readonly"));
		assert.ok(snapshot.startsWith(`type=bind,src=${realpathSync.native(tmpdir())}${sep}se-build-lock-`));
		assert.ok(snapshot.endsWith(",dst=/repo/docker/seed-data/external_plugins/surface_export/package-lock.json,readonly"));
		assert.equal(existsSync(snapshot.slice("type=bind,src=".length).split(",dst=")[0]), false);
		assert.ok(args.at(-1).includes("SE_SKIP_PREPARE=1 npm ci"));
	}
});

test("a failed test container fails the wrapper without restarting the cluster", { skip }, t => {
	const result = run(t, "test", true);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Plugin build failed/);
	assert.deepEqual(result.calls.map(args => args[0]), ["ps", "version", "run"]);
});

test("a linked worktree builds with its own dependency volume", { skip }, t => {
	const result = run(t, "test", false, { linked: true });
	assert.equal(result.status, 0, result.stderr || result.stdout);
	const args = result.calls.find(call => call[0] === "run");
	assert.match(args[args.indexOf("-v") + 1], /^se_plugin_build_nm_[0-9a-f]{12}:\/repo\/docker\/seed-data\/external_plugins\/surface_export\/node_modules$/);
});

test("a restart from a checkout the cluster does not run from refuses before building", { skip }, t => {
	const elsewhere = join(tmpdir(), "another-checkout");
	const result = run(t, "node", false, { restart: true, clusterRoot: elsewhere });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /runs from/);
	assert.deepEqual(result.calls.map(args => args[0]), ["ps"]);
	const isolated = run(t, "node", false, { clusterRoot: elsewhere });
	assert.equal(isolated.status, 0, isolated.stderr || isolated.stdout);
	assert.deepEqual(isolated.calls.map(args => args[0]), ["version", "run"]);
});

test("cleanup failure warns without replacing a build failure or changing a successful exit", { skip }, t => {
	for (const fail of [false, true]) {
		const result = run(t, "test", fail, { failCleanup: true });
		assert.equal(result.status === 0, !fail, result.stderr);
		assert.match(result.stdout + result.stderr, /Could not remove build lock snapshot[^\n]*injected cleanup sharing violation/);
		if (fail) assert.match(result.stderr, /Plugin build failed/);
	}
});

const shell = process.platform === "win32"
	? { command: "docker", args: ["run", "--rm", "-i", "node:24-bookworm-slim", "sh"] }
	: { command: "sh", args: [] };
const shellSkip = skip || ((process.platform === "win32"
	&& spawnSync("docker", ["image", "inspect", "node:24-bookworm-slim"], { stdio: "ignore" }).status !== 0)
	? "requires the local build image on Windows" : false);

for (const failure of ["build:browser", "build:web", null]) {
	test(`web build shell ${failure ? `stops on ${failure} failure` : "reports successful completion"}`,
		{ skip: shellSkip }, t => {
			const capture = run(t, "web");
			assert.equal(capture.status, 0, capture.stderr);
			const buildCommand = capture.calls.find(args => args[0] === "run").at(-1);
			const fixture = `
cd "$(mktemp -d)"
trap 'rm -rf "$PWD"' EXIT
node() { echo v24-fixture; }
npm() {
 echo "fixture-npm:$*"
 if [ "$2" = "${failure ?? "no-failure"}" ]; then return 17; fi
 mkdir -p node_modules
 return 0
}

${buildCommand}
`;
			const result = spawnSync(shell.command, shell.args, { input: fixture, encoding: "utf8", timeout: 30000 });
			assert.equal(result.status, failure ? 17 : 0, result.stderr || result.stdout);
			if (failure) assert.doesNotMatch(result.stdout, /\[ok\] build complete/);
			else assert.match(result.stdout, /\[ok\] build complete/);
			if (failure === "build:browser") assert.doesNotMatch(result.stdout, /fixture-npm:run build:web/);
		});
}

test("staged packages resolve from the repository and dependency reuse follows lock content", { skip: shellSkip }, t => {
	const stage = mkdtempSync(join(repo, "ci-artifacts", "build-cache-test-"));
	t.after(() => rmSync(stage, { recursive: true, force: true }));
	const packageDirectory = stage.slice(repo.length + 1);
	const commands = [];
	for (const contents of ["lock-a", "lock-b", "lock-a"]) {
		writeFileSync(join(stage, "package-lock.json"), contents);
		const input = contents === "lock-b" ? stage : packageDirectory;
		const result = run(t, "node", false, { cwd: tmpdir(), packageDirectory: input,
			outputDirectory: `${input}/dist` });
		assert.equal(result.status, 0, result.stderr || result.stdout);
		const args = result.calls.find(call => call[0] === "run");
		assert.ok(args.includes(`type=bind,src=${stage},dst=/app`));
		commands.push(args.at(-1));
	}
	const changed = run(t, "node", false, { packageDirectory, outputDirectory: `${packageDirectory}/dist`,
		mutateLock: join(stage, "package-lock.json") });
	assert.notEqual(changed.status, 0);
	assert.match(changed.stderr, /package-lock.json changed during the build/);
	assert.equal(changed.snapshot, "lock-a");
	const result = spawnSync(shell.command, shell.args, { input: `
cd "$(mktemp -d)"
trap 'rm -rf "$PWD"' EXIT
node() { echo v24-fixture; }
npm() {
 if [ "$1" = ci ]; then
  echo INSTALL
  mkdir -p node_modules/.bin
  touch node_modules/.bin/webpack-cli node_modules/.package-lock.json
  chmod +x node_modules/.bin/webpack-cli
 fi
}
touch -t 200001010000 package-lock.json
${[commands[0], commands[0], commands[1], commands[2]].join("\n")}
`, encoding: "utf8", timeout: 30000 });
	assert.equal(result.status, 0, result.stderr || result.stdout);
	assert.equal(result.stdout.split("\n").filter(line => line === "INSTALL").length, 3, result.stdout);
	const failed = spawnSync(shell.command, shell.args, { input: `
cd "$(mktemp -d)"
trap 'if [ -f node_modules/.se-build-lock-sha256 ]; then echo STALE_CACHE; fi; rm -rf "$PWD"' EXIT
mkdir -p node_modules/.bin
touch node_modules/.bin/webpack-cli
chmod +x node_modules/.bin/webpack-cli
echo stale > node_modules/.se-build-lock-sha256
node() { echo v24-fixture; }
npm() { return 17; }
${commands[0]}
`, encoding: "utf8", timeout: 30000 });
	assert.equal(failed.status, 17, failed.stderr || failed.stdout);
	assert.doesNotMatch(failed.stdout, /STALE_CACHE|\[ok\] build complete/);
});

test("disabled save patching refuses before any RCON save, stop or restart", { skip }, () => {
	const command = `
function global:docker {
 $global:LASTEXITCODE = 0
 if (($args -join ' ') -match 'instance config list') {
  'factorio.enable_save_patching false'
  'instance.auto_start true'
 } elseif ($args[0] -eq 'ps') {
  "surface-export-controller|$env:RELOAD_ROOT"
 } elseif (($args -join ' ') -match 'instance list') {
  'header'; '-----'
  'clusterio-host-1-instance-1 | 1 | 1 | 34100 | running |'
  'clusterio-host-2-instance-1 | 2 | 2 | 34200 | running |'
 } else { throw 'UNEXPECTED_MUTATION' }
}
function global:node { throw 'UNEXPECTED_PROBE_OR_MUTATION' }
try { & $env:RELOAD_SCRIPT }
catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
`;
	const result = spawnSync("pwsh", ["-NoProfile", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")],
		{ encoding: "utf8", timeout: 15000, env: { ...process.env, RELOAD_ROOT: repo,
			RELOAD_SCRIPT: fileURLToPath(new URL("../../tools/clusterio/reload-saves.ps1", import.meta.url)) } });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /save patching and auto-start must be enabled/);
	assert.doesNotMatch(result.stderr, /UNEXPECTED/);
});
