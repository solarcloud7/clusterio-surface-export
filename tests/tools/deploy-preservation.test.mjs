import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";

const skip = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" }).status !== 0;

function fixture(t, script) {
	const dir = mkdtempSync(join(tmpdir(), "deploy-preservation-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const put = (name, text) => { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), text); };
	put("tools/shared/cluster-utils.ps1", `
function Assert-PluginArtifactsFresh { $global:calls.Add('fresh') }
function Update-PackageLockVersion {}
function Update-ModuleVersionStamp {}
function Update-ModuleBuildStamp { 'fixture' }
function Get-SeededInstances { @(@{Host='one';Instance='world';Container='fixture-host'}) }
`);
	put("tools/shared/workflow-lock.ps1", "function Invoke-WorkflowLock { param([scriptblock]$Action) & $Action }");
	put("tools/shared/version-utils.ps1", "function Get-NextPluginVersion { param($Version) $Version }");
	for (const name of ["build-plugin", "reload-saves", "patch-and-reset", "deploy-cluster"]) {
		put(`tools/clusterio/${name}.ps1`, `$global:calls.Add('${name} ' + ($args -join ' '))`);
	}
	copyFileSync(new URL(`../../tools/clusterio/${script}.ps1`, import.meta.url), join(dir, `tools/clusterio/${script}.ps1`));
	put("docker/seed-data/external_plugins/surface_export/package.json", '{"version":"1.0.0"}');
	put("docker/seed-data/hosts/one/world/instance.json", '{"factorio.version":"2.1.17"}');
	put(".env", "EXPORT_HOST=1\n");
	return { dir, put };
}

function run(dir, script, args, setup = "") {
	const command = `
$ErrorActionPreference='Stop'
$global:calls=[Collections.Generic.List[string]]::new()
function docker { $global:calls.Add('docker ' + ($args -join ' ')); $global:LASTEXITCODE=0 }
${setup}
$failure=$null
try { & $env:DEPLOY_SCRIPT ${args.map(s => s.startsWith("-") ? s : `'${s}'`).join(" ")} } catch { $failure=$_.Exception.Message }
@{calls=@($global:calls);error=$failure} | ConvertTo-Json -Compress
`;
	const result = spawnSync("pwsh", ["-NoProfile", "-Command", command], { cwd: dir, encoding: "utf8",
		env: { ...process.env, DEPLOY_SCRIPT: join(dir, `tools/clusterio/${script}.ps1`) } });
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
}

test("Lua and plugin deployment preserve saves unless reset is explicit", { skip }, t => {
	const { dir } = fixture(t, "deploy");
	for (const scope of ["lua", "plugin"]) {
		const normal = run(dir, "deploy", ["-Scope", scope]);
		assert.equal(normal.error, null);
		assert.ok(normal.calls.some(c => c.startsWith("reload-saves")), JSON.stringify(normal));
		assert.ok(!normal.calls.some(c => c.startsWith("patch-and-reset")));
		const reset = run(dir, "deploy", ["-Scope", scope, "-ResetSaves", "-SkipIncrement"]);
		assert.equal(reset.error, null);
		assert.ok(reset.calls.some(c => c.startsWith("patch-and-reset")));
		const conflict = run(dir, "deploy", ["-Scope", scope, "-KeepSaves", "-ResetSaves"]);
		assert.ok(conflict.error); assert.deepEqual(conflict.calls, []);
	}
});

test("cluster deployment forwards reset only on explicit request", { skip }, t => {
	const { dir } = fixture(t, "deploy");
	const normal = run(dir, "deploy", ["-Scope", "cluster", "-SkipIncrement"]);
	assert.equal(normal.error, null);
	assert.ok(normal.calls.every(c => !c.includes("ResetData")));
	const reset = run(dir, "deploy", ["-Scope", "cluster", "-ResetData", "-SkipIncrement"]);
	assert.equal(reset.error, null);
	assert.ok(reset.calls.some(c => c.includes("ResetData")));
});

test("direct cluster helper never deletes volumes without ResetData", { skip }, t => {
	const { dir, put } = fixture(t, "deploy-cluster");
	put("tools/clusterio/build-plugin.ps1", "throw 'fixture stopped after compose down'");
	for (const [flags, reset] of [[[], false], [["-KeepData"], false], [["-ResetData"], true]]) {
		const result = run(dir, "deploy-cluster", ["-SkipIncrement", ...flags]);
		assert.equal(result.error, "fixture stopped after compose down");
		assert.equal(result.calls.includes("docker compose down -v"), reset, JSON.stringify(result));
	}
	const conflict = run(dir, "deploy-cluster", ["-KeepData", "-ResetData", "-SkipIncrement"]);
	assert.ok(conflict.error); assert.deepEqual(conflict.calls, []);
});

test("preserving cluster volumes also preserves the selected version", { skip }, t => {
	const { dir, put } = fixture(t, "deploy-cluster");
	copyFileSync(new URL("../../tools/shared/version-utils.ps1", import.meta.url), join(dir, "tools/shared/version-utils.ps1"));
	put("tools/clusterio/build-plugin.ps1", "throw 'fixture stopped after compose down'");
	const result = run(dir, "deploy-cluster", []);
	assert.equal(result.error, "fixture stopped after compose down");
	assert.equal(JSON.parse(readFileSync(join(dir, "docker/seed-data/external_plugins/surface_export/package.json"))).version, "1.0.0");
});

for (const stale of [false, true]) {
	test(`cluster deployment checks loaded build with retained volumes, stale=${stale}`, { skip }, t => {
		const { dir, put } = fixture(t, "deploy-cluster");
		copyFileSync(new URL("../../tools/shared/version-utils.ps1", import.meta.url), join(dir, "tools/shared/version-utils.ps1"));
		put("tools/shared/cluster-utils.ps1", `
function Update-PackageLockVersion {}
function Update-ModuleVersionStamp {}
function Update-ModuleBuildStamp { '${"a".repeat(32)}' }
function Get-SeededInstances { @(@{Host='one';Instance='clusterio-host-1-instance-1';Container='fixture-host'}) }
`);
		put("docker/seed-data/hosts/one/clusterio-host-1-instance-1/instance.json", '{"factorio.version":"2.1.17"}');
		put("docker-compose.yml", "volumes:\n  fixture-client:\n    external: true\n");
		put("tools/clusterio/sync-client-mods.ps1", "$global:calls.Add('sync-client')");
		const result = run(dir, "deploy-cluster", ["-SkipIncrement"], `
function Start-Sleep {}
function Start-Job { 1 }
function Receive-Job { 'Seeding complete' }
function Stop-Job {}
function Remove-Job {}
function docker {
 $global:calls.Add('docker ' + ($args -join ' ')); $global:LASTEXITCODE=0
 if ($args[0] -eq 'inspect') { return 'healthy' }
 if (($args -join ' ') -match 'instance list') { return 'clusterio-host-1-instance-1 running' }
 if (($args -join ' ') -match 'send-rcon') { return '{"version":"1.0.0","buildId":"${(stale ? "b" : "a").repeat(32)}"}' }
}
`);
		if (stale) {
			assert.match(result.error || "", /STALE module code/);
			assert.equal(result.calls.includes("sync-client"), false);
		} else {
			assert.equal(result.error, null);
			assert.ok(result.calls.includes("sync-client"));
		}
		assert.equal(result.calls.includes("docker compose down -v"), false);
	});
}
