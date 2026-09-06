import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repo = realpathSync.native(fileURLToPath(new URL("../../", import.meta.url)));
const script = join(repo, "tools", "clusterio", "build-plugin.ps1");
const skip = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"],
	{ stdio: "ignore" }).status === 0 ? false : "requires pwsh";

function run(t, target, fail = false) {
	const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "build-plugin-mount-")));
	assert.ok(dir.startsWith(realpathSync.native(tmpdir()) + sep));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const calls = join(dir, "calls.jsonl");
	const command = `
function global:docker {
 $arguments = @($args)
 ConvertTo-Json -InputObject $arguments -Compress | Add-Content -LiteralPath $env:BUILD_CALLS
 $global:LASTEXITCODE = 0
 switch ($arguments[0]) {
  'version' { 'fixture server' }
  'run' { if ($env:BUILD_FAIL -eq 'true') { $global:LASTEXITCODE = 5 } }
  default { throw 'unexpected Docker operation' }
 }
}
if ($env:BUILD_FAIL -eq 'true') {
 & $env:BUILD_SCRIPT $env:BUILD_TARGET -RestartController -RestartHosts
} else {
 & $env:BUILD_SCRIPT $env:BUILD_TARGET
}
exit $LASTEXITCODE
`;
	const result = spawnSync("pwsh", ["-NoProfile", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")],
		{ encoding: "utf8", timeout: 15000, env: { ...process.env, BUILD_SCRIPT: script, BUILD_TARGET: target,
			BUILD_CALLS: calls, BUILD_FAIL: String(fail) } });
	return { ...result, calls: readFileSync(calls, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line)) };
}

test("lint and unit tests see the full checkout with isolated plugin dependencies", { skip }, t => {
	for (const target of ["lint", "test"]) {
		const result = run(t, target);
		assert.equal(result.status, 0, result.stderr || result.stdout);
		assert.deepEqual(result.calls.map(args => args[0]), ["version", "run"]);
		const args = result.calls[1];
		assert.equal(args[args.indexOf("--mount") + 1], `type=bind,src=${repo},dst=/repo`);
		assert.equal(args[args.indexOf("-w") + 1], "/repo/docker/seed-data/external_plugins/surface_export");
		assert.equal(args[args.indexOf("-v") + 1], "se_plugin_build_nm:/repo/docker/seed-data/external_plugins/surface_export/node_modules");
		assert.ok(args.includes("node:24-bookworm-slim"));
		assert.ok(args.at(-1).includes(target === "test" ? "npm test" : "npm run lint"));
	}
});

test("a failed test container fails the wrapper without restarting the cluster", { skip }, t => {
	const result = run(t, "test", true);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Plugin build failed/);
	assert.deepEqual(result.calls.map(args => args[0]), ["version", "run"]);
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
node() { echo v24-fixture; }
npm() {
 echo "fixture-npm:$*"
 if [ "$2" = "${failure ?? "no-failure"}" ]; then return 17; fi
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
