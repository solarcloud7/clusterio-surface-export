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

function retainedCluster(t, { configured = "2.1.17", stale = false, flags = [] } = {}) {
	const { dir, put } = fixture(t, "deploy-cluster");
	copyFileSync(new URL("../../tools/shared/version-utils.ps1", import.meta.url), join(dir, "tools/shared/version-utils.ps1"));
	put("tools/shared/cluster-utils.ps1", `
function Assert-DevelopmentClusterCheckout {}
function Update-PackageLockVersion {}
function Update-ModuleVersionStamp {}
function Update-ModuleBuildStamp { '${"a".repeat(32)}' }
function Get-SeededInstances { @(@{Host='one';Instance='clusterio-host-1-instance-1';Container='fixture-host'}) }
`);
	put("docker/seed-data/hosts/one/clusterio-host-1-instance-1/instance.json", '{"factorio.version":"2.1.17"}');
	put("tools/clusterio/sync-client-mods.ps1", "$global:calls.Add('sync-client')");
	return run(dir, "deploy-cluster", ["-SkipIncrement", ...flags], `
function Start-Sleep {}
function Start-Job { 1 }
function Receive-Job { 'Seeding complete' }
function Stop-Job {}
function Remove-Job {}
function docker {
 $global:calls.Add('docker ' + ($args -join ' ')); $global:LASTEXITCODE=0
 if ($args[0] -eq 'inspect') { return 'healthy' }
 if (($args -join ' ') -match 'instance config list') { return 'factorio.version "${configured}"' }
 if (($args -join ' ') -match 'instance list') { return 'clusterio-host-1-instance-1 running' }
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

test("a retained instance on another engine is refused before the hosts start", { skip }, t => {
	const result = retainedCluster(t, { configured: "2.1.16" });
	assert.match(result.error || "", /clusterio-host-1-instance-1=2\.1\.16 do not match the seed engine pin 2\.1\.17.*-MigrateEngine/s);
	assert.ok(result.calls.includes("docker compose up -d surface-export-controller"), JSON.stringify(result));
	assert.equal(result.calls.includes("docker compose up -d"), false);
	assert.equal(result.calls.some(c => c.includes("instance config set")), false);
});

test("-MigrateEngine sets the pinned version before the hosts start", { skip }, t => {
	const result = retainedCluster(t, { configured: "2.1.16", flags: ["-MigrateEngine"] });
	assert.equal(result.error, null);
	const set = result.calls.findIndex(c => /instance config set clusterio-host-1-instance-1 factorio\.version 2\.1\.17$/.test(c));
	const hosts = result.calls.indexOf("docker compose up -d");
	assert.ok(set >= 0 && hosts > set, JSON.stringify(result.calls));
});

test("-MigrateEngine leaves instances already on the pin unchanged", { skip }, t => {
	const result = retainedCluster(t, { flags: ["-MigrateEngine"] });
	assert.equal(result.error, null);
	assert.equal(result.calls.some(c => c.includes("instance config set")), false);
});
