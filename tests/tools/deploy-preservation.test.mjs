import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const skip = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" }).status !== 0;

function fixture(t, script) {
	const dir = mkdtempSync(join(tmpdir(), "deploy-preservation-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const put = (name, text) => { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), text); };
	put("tools/shared/cluster-utils.ps1", `
function Assert-DevelopmentClusterCheckout { $global:calls.Add('checkout'); if ($global:refuseCheckout) { throw 'CHECKOUT_REFUSED' } }
function Assert-PluginArtifactsFresh { $global:calls.Add('fresh') }
function Update-PackageLockVersion { $global:calls.Add('lock-version') }
function Update-ModuleVersionStamp { $global:calls.Add('module-version') }
function Update-ModuleBuildStamp { $global:calls.Add('build-stamp'); 'fixture' }
function Get-SeededInstances { @(@{Host='one';Instance='world';Container='fixture-host'}) }
function Stop-HostInstances { param([string[]]$HostNumber) $global:calls.Add('stop-instances ' + ($HostNumber -join ',')); if ($global:refuseStop) { throw 'STOP_FAILED' } }
function Sync-ControllerWebBundle { $global:calls.Add('sync-web') }
`);
	put("tools/shared/workflow-lock.ps1", "function Invoke-WorkflowLock { param([scriptblock]$Action) & $Action }");
	put("tools/shared/version-utils.ps1", "function Get-NextPluginVersion { param($Version) $Version }");
	for (const name of ["build-plugin", "reload-saves", "patch-and-reset", "deploy-cluster"]) {
		put(`tools/clusterio/${name}.ps1`, `$global:calls.Add('${name} ' + ($args -join ' '))`);
	}
	copyFileSync(new URL(`../../tools/clusterio/${script}.ps1`, import.meta.url), join(dir, `tools/clusterio/${script}.ps1`));
	put("docker/seed-data/external_plugins/surface_export/package.json", '{"version":"1.0.0"}');
	put("docker/seed-data/hosts/one/world/instance.json", '{"factorio.version":"2.1.17"}');
	put("docker-compose.yml", compose("2.1.17"));
	put(".env", "EXPORT_HOST=1\n");
	return { dir, put };
}

function compose(tag) {
	return `services:\n  host:\n    environment:\n      - FACTORIO_CLIENT_TAG=${tag}\nvolumes:\n  fixture-client:\n    external: true\n`;
}

function run(dir, script, args, setup = "") {
	const command = `
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$ErrorActionPreference='Stop'
$global:calls=[Collections.Generic.List[string]]::new()
function docker { $global:calls.Add('docker ' + ($args -join ' ')); $global:LASTEXITCODE=0 }
function node { $global:calls.Add('node ' + (Split-Path $args[0] -Leaf) + ' ' + $args[1]); $global:LASTEXITCODE = [int]$global:seedModsExit }
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
	assert.ok(normal.calls.every(c => !c.includes("ResetData") && !c.includes("MigrateEngine")));
	const reset = run(dir, "deploy", ["-Scope", "cluster", "-ResetData", "-SkipIncrement"]);
	assert.equal(reset.error, null);
	assert.ok(reset.calls.some(c => c.includes("ResetData")));
	const migrate = run(dir, "deploy", ["-Scope", "cluster", "-MigrateEngine", "-SkipIncrement"]);
	assert.equal(migrate.error, null);
	assert.ok(migrate.calls.some(c => c.startsWith("deploy-cluster") && c.includes("MigrateEngine")), JSON.stringify(migrate));
	const wrongScope = run(dir, "deploy", ["-Scope", "lua", "-MigrateEngine"]);
	assert.match(wrongScope.error || "", /does not accept: MigrateEngine/);
});

test("an artifacts deployment stops the instances before any controller or host restart", { skip }, t => {
	const { dir } = fixture(t, "deploy");
	const hostRestart = "docker restart surface-export-host-1 surface-export-host-2";
	const restarted = run(dir, "deploy", ["-Scope", "artifacts", "-RestartHosts"]);
	assert.equal(restarted.error, null, JSON.stringify(restarted));
	const stop = restarted.calls.indexOf("stop-instances 1,2");
	assert.ok(stop >= 0 && stop < restarted.calls.indexOf("sync-web") && stop < restarted.calls.indexOf(hostRestart), JSON.stringify(restarted.calls));
	const refused = run(dir, "deploy", ["-Scope", "artifacts", "-RestartHosts"], "$global:refuseStop = $true");
	assert.equal(refused.error, "STOP_FAILED");
	assert.equal(refused.calls.some(c => c === "sync-web" || c.startsWith("docker restart")), false, JSON.stringify(refused.calls));
	const kept = run(dir, "deploy", ["-Scope", "artifacts"]);
	assert.equal(kept.error, null);
	assert.equal(kept.calls.some(c => c.startsWith("stop-instances") || c.startsWith("docker restart")), false, JSON.stringify(kept.calls));
});

test("every deployment entry point refuses from the wrong checkout before any work", { skip }, t => {
	const cases = [
		...["artifacts", "lua", "plugin", "cluster"].map(scope => ["deploy", ["-Scope", scope]]),
		["reload-saves", []], ["patch-and-reset", ["-SkipIncrement"]], ["deploy-cluster", ["-SkipIncrement"]],
	];
	for (const [script, args] of cases) {
		const { dir } = fixture(t, script);
		const refused = run(dir, script, args, "$global:refuseCheckout = $true");
		assert.equal(refused.error, "CHECKOUT_REFUSED", `${script} ${args.join(" ")}: ${JSON.stringify(refused)}`);
		assert.deepEqual(refused.calls, ["checkout"], `${script} ${args.join(" ")}`);
	}
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
	const migrateReset = run(dir, "deploy-cluster", ["-MigrateEngine", "-ResetData", "-SkipIncrement"]);
	assert.match(migrateReset.error || "", /cannot be combined with -ResetData/); assert.deepEqual(migrateReset.calls, []);
});

test("a compose client tag that disagrees with the seed pin is refused before the cluster stops", { skip }, t => {
	const { dir, put } = fixture(t, "deploy-cluster");
	put("docker-compose.yml", compose("2.1.20"));
	put(".env", "EXPORT_HOST=1\nFACTORIO_CLIENT_TAG=2.1.17\n");
	const result = run(dir, "deploy-cluster", ["-SkipIncrement"]);
	assert.match(result.error || "", /FACTORIO_CLIENT_TAG=2\.1\.20 but instance\.json pins factorio\.version 2\.1\.17/);
	assert.equal(result.calls.some(c => c.startsWith("docker compose")), false, JSON.stringify(result));
});

test("the documented migration failure is recognized only for the named instance", { skip }, () => {
	const failure = "Cannot execute command. Error: [string \"clusterio_private.update_instance(...\"]:1: attempt to index global 'clusterio_private' (a nil value)";
	const cases = [
		[`[ERROR] Error during auto startup for world-1:\nError: Expected empty response but got "${failure}"`, "world-1", true],
		[`[ERROR] Error during auto startup for world-1:\nError: Unable to find Factorio version 2.1.17`, "world-1", false],
		[`[ERROR] Error during auto startup for world-10:\nError: ${failure}`, "world-1", false],
		[`[ERROR] Error during auto startup for world-1:\nError: invalid mod\n[ERROR] Error during auto startup for world-2:\nError: ${failure}`, "world-1", false],
		["", "world-1", false],
	];
	const result = spawnSync("pwsh", ["-NoProfile", "-Command",
		". $env:CLUSTER_UTILS; ConvertTo-Json -Compress @($env:MIGRATION_CASES | ConvertFrom-Json | ForEach-Object { Test-ScenarioMigrationFailure -Log $_.log -Instance $_.name })"],
	{ encoding: "utf8", env: { ...process.env, CLUSTER_UTILS: fileURLToPath(new URL("../../tools/shared/cluster-utils.ps1", import.meta.url)),
		MIGRATION_CASES: JSON.stringify(cases.map(([log, name]) => ({ log, name }))) } });
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout.trim()), cases.map(([, , expected]) => expected));
});

test("preserving cluster volumes also preserves the selected version", { skip }, t => {
	const { dir, put } = fixture(t, "deploy-cluster");
	copyFileSync(new URL("../../tools/shared/version-utils.ps1", import.meta.url), join(dir, "tools/shared/version-utils.ps1"));
	put("tools/clusterio/build-plugin.ps1", "throw 'fixture stopped after compose down'");
	const result = run(dir, "deploy-cluster", []);
	assert.equal(result.error, "fixture stopped after compose down");
	assert.equal(JSON.parse(readFileSync(join(dir, "docker/seed-data/external_plugins/surface_export/package.json"))).version, "1.0.0");
});

const psQuote = s => `'${s.replace(/'/g, "''")}'`;
const NEGATIVE_RCON = "-140462620.552 Info RemoteCommandProcessor.cpp:119: Starting RCON interface at IP ADDR:({0.0.0.0:64865})";

function retainedCluster(t, { configured = "2.1.17", stale = false, flags = [], stoppedLog = null, recovers = true, startHangs = 0, running = [], listExit = 0 } = {}) {
	const { dir, put } = fixture(t, "deploy-cluster");
	copyFileSync(new URL("../../tools/shared/version-utils.ps1", import.meta.url), join(dir, "tools/shared/version-utils.ps1"));
	copyFileSync(new URL("../../tools/shared/instance-identity.ps1", import.meta.url), join(dir, "tools/shared/instance-identity.ps1"));
	copyFileSync(new URL("../../tools/shared/cluster-utils.ps1", import.meta.url), join(dir, "tools/shared/cluster-utils.real.ps1"));
	put("tools/shared/cluster-utils.ps1", `
. "$PSScriptRoot/cluster-utils.real.ps1"
function Assert-DevelopmentClusterCheckout {}
function Update-PackageLockVersion {}
function Update-ModuleVersionStamp {}
function Update-ModuleBuildStamp { '${"a".repeat(32)}' }
function Get-SeededInstances { @(@{Host='clusterio-host-1';HostNumber=1;Instance='clusterio-host-1-instance-1';Container='fixture-host'}) }
`);
	put("docker/seed-data/hosts/clusterio-host-1/clusterio-host-1-instance-1/instance.json", '{"factorio.version":"2.1.17"}');
	put("tools/clusterio/sync-client-mods.ps1", "$global:calls.Add('sync-client')");
	const failFast = stoppedLog === null ? [] : ["-StoppedFailFastS", "0"];
	return run(dir, "deploy-cluster", ["-SkipIncrement", ...failFast, ...flags], `
function Start-Sleep {}
function Start-Job { 1 }
function Receive-Job { 'Seeding complete' }
function Stop-Job {}
function Remove-Job {}
$global:started = ${stoppedLog === null ? "$true" : "$false"}
$global:hangs = ${startHangs}
function docker {
 $global:calls.Add('docker ' + ($args -join ' ')); $global:LASTEXITCODE=0
 if ($args[0] -eq 'ps') { return @(${running.map(psQuote).join(", ")}) }
 if (($args -join ' ') -eq 'compose up -d' -and ${running.length ? "$true" : "$false"}) { $global:started = $true }
 if ($args[0] -eq 'inspect') { return 'healthy' }
 if ($args[0] -eq 'logs') { return ${psQuote(stoppedLog ?? "")} }
 if ($args[2] -eq 'sh' -and ($args -join ' ') -match 'instance\\.json') { return ('/clusterio/data/instances/clusterio-host-1-instance-1/instance.json' + [char]9 + '{"instance.id": 836570928}') }
 if ($args[2] -eq 'sh' -and ($args -join ' ') -match 'Starting RCON interface') { return ${psQuote(NEGATIVE_RCON)} }
 if ($args[2] -eq 'sh' -and ($args -join ' ') -match '/proc/') { return }
 if (($args -join ' ') -match 'instance stop') { $global:started = $false; return }
 if (($args -join ' ') -match 'instance start') { if ($global:hangs -gt 0) { $global:hangs--; $global:LASTEXITCODE = 124; return } $global:started = ${recovers ? "$true" : "$false"}; return }
 if (($args -join ' ') -match 'instance config list') { return 'factorio.version "${configured}"' }
 if (($args -join ' ') -match 'instance list') { $global:LASTEXITCODE = ${listExit}; return @('name | id | assignedHost | gamePort | status', '---', ('Dev One | 836570928 | 1 | 34100 | ' + $(if ($global:started) { 'running' } else { 'stopped' }))) }
 if (($args -join ' ') -match 'send-rcon') { return '{"version":"1.0.0","buildId":"${(stale ? "b" : "a").repeat(32)}"}' }
}
`);
}

for (const stale of [false, true]) {
	test(`cluster deployment checks loaded build with retained volumes, stale=${stale}`, { skip }, t => {
		const result = retainedCluster(t, { stale });
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

test("a running cluster's instances are stopped and reported stopped before compose down", { skip }, t => {
	const result = retainedCluster(t, { running: ["surface-export-controller", "fixture-host"] });
	assert.equal(result.error, null, JSON.stringify(result));
	const stop = result.calls.findIndex(c => /^docker exec surface-export-controller timeout -k 10 420 .* instance stop 836570928$/.test(c));
	const down = result.calls.indexOf("docker compose down");
	assert.ok(stop >= 0 && down > stop, JSON.stringify(result.calls));
	assert.ok(result.calls.slice(stop, down).some(c => c.startsWith("docker exec surface-export-host-1 sh -c ") && c.includes("/proc/")), JSON.stringify(result.calls));
});

test("a cluster whose instances cannot be stopped is not brought down", { skip }, t => {
	const unreadable = retainedCluster(t, { running: ["surface-export-controller", "fixture-host"], listExit: 1 });
	assert.match(unreadable.error || "", /clusterioctl instance list failed \(exit 1\)/);
	assert.equal(unreadable.calls.some(c => c.startsWith("docker compose")), false, JSON.stringify(unreadable.calls));
	const headless = retainedCluster(t, { running: ["fixture-host"] });
	assert.match(headless.error || "", /fixture-host running without surface-export-controller, so their instances cannot be stopped/);
	assert.equal(headless.calls.some(c => c.startsWith("docker compose") || c.includes("instance stop")), false, JSON.stringify(headless.calls));
});

test("a seed mod set that disagrees with the pin is refused before the cluster stops", { skip }, t => {
	const { dir } = fixture(t, "deploy-cluster");
	const result = run(dir, "deploy-cluster", ["-SkipIncrement"], "$global:seedModsExit = 1");
	assert.match(result.error || "", /does not match docker\/seed-data\/seed-mods\.json/);
	assert.ok(result.calls.includes("node seed-mods.mjs verify"), JSON.stringify(result.calls));
	assert.equal(result.calls.some(c => c.startsWith("docker ")), false, JSON.stringify(result.calls));
});

test("a retained instance on another engine is refused before the hosts start", { skip }, t => {
	const result = retainedCluster(t, { configured: "2.1.16" });
	assert.match(result.error || "", /Dev One=2\.1\.16 do not match the seed engine pin 2\.1\.17.*-MigrateEngine/s);
	assert.ok(result.calls.includes("docker compose up -d surface-export-controller"), JSON.stringify(result));
	assert.equal(result.calls.includes("docker compose up -d"), false);
	assert.equal(result.calls.some(c => c.includes("instance config set")), false);
});

test("-MigrateEngine sets the pinned version before the hosts start", { skip }, t => {
	const result = retainedCluster(t, { configured: "2.1.16", flags: ["-MigrateEngine"] });
	assert.equal(result.error, null);
	const set = result.calls.findIndex(c => /instance config set 836570928 factorio\.version 2\.1\.17$/.test(c));
	const hosts = result.calls.indexOf("docker compose up -d");
	assert.ok(set >= 0 && hosts > set, JSON.stringify(result.calls));
});

const scenarioFailure = "[ERROR] Error during auto startup for Dev One:\nError: Expected empty response but got \"Cannot execute command. Error: [string \"clusterio_private.update_instance(836570928, ...\"]:1: attempt to index global 'clusterio_private' (a nil value)\n\"";
const startCall = c => /instance start 836570928$/.test(c);

test("an instance migrated by an earlier interrupted run is started once more on the documented error", { skip }, t => {
	const result = retainedCluster(t, { stoppedLog: scenarioFailure });
	assert.equal(result.error, null, JSON.stringify(result));
	assert.equal(result.calls.filter(startCall).length, 1, JSON.stringify(result.calls));
});

test("a documented-error restart that does not return is stopped and started once more", { skip }, t => {
	const result = retainedCluster(t, { stoppedLog: scenarioFailure, startHangs: 1 });
	assert.equal(result.error, null, JSON.stringify(result));
	const starts = result.calls.map((c, i) => startCall(c) ? i : -1).filter(i => i >= 0);
	assert.equal(starts.length, 2, JSON.stringify(result.calls));
	assert.ok(result.calls[starts[0]].startsWith("docker exec surface-export-controller timeout -k 10 180 npx clusterioctl "), result.calls[starts[0]]);
	const between = result.calls.slice(starts[0] + 1, starts[1]);
	assert.ok(between.some(c => /^docker exec surface-export-controller timeout -k 10 420 .* instance stop 836570928$/.test(c)), JSON.stringify(between));
	assert.ok(between.some(c => c.startsWith("docker exec surface-export-controller sh -c ") && c.endsWith(" sh 836570928")), JSON.stringify(between));
});

test("a documented-error restart that does not return twice fails with the diagnosis", { skip }, t => {
	const result = retainedCluster(t, { stoppedLog: scenarioFailure, startHangs: 2 });
	assert.ok(result.error?.includes("instance start 836570928 did not return within 180s twice"), result.error);
	assert.ok(result.error.includes(`never saw RCON ready: '${NEGATIVE_RCON}'`), result.error);
	assert.equal(result.calls.filter(startCall).length, 2, JSON.stringify(result.calls));
});

test("the documented-error restart is attempted only once", { skip }, t => {
	const result = retainedCluster(t, { stoppedLog: scenarioFailure, recovers: false });
	assert.match(result.error || "", /has been 'stopped' for 0s — a save-load failure/);
	assert.equal(result.calls.filter(startCall).length, 1, JSON.stringify(result.calls));
});

test("a stopped instance without the documented error is refused, not restarted", { skip }, t => {
	const result = retainedCluster(t, { stoppedLog: "[ERROR] Error during auto startup for Dev One:\nError: save is corrupt" });
	assert.match(result.error || "", /has been 'stopped' for 0s — a save-load failure/);
	assert.equal(result.calls.some(startCall), false, JSON.stringify(result.calls));
});

test("an instance migrated in this run without the documented error names -MigrateEngine", { skip }, t => {
	const result = retainedCluster(t, { configured: "2.1.16", flags: ["-MigrateEngine"], stoppedLog: "" });
	assert.match(result.error || "", /stopped after -MigrateEngine without Clusterio's documented scenario-migration error/);
	assert.equal(result.calls.some(startCall), false, JSON.stringify(result.calls));
});

test("-MigrateEngine leaves instances already on the pin unchanged", { skip }, t => {
	const result = retainedCluster(t, { flags: ["-MigrateEngine"] });
	assert.equal(result.error, null);
	assert.equal(result.calls.some(c => c.includes("instance config set")), false);
});
