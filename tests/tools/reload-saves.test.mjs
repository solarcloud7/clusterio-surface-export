import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const skip = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" }).status !== 0;
const repo = new URL("../../", import.meta.url);
const IDS = { 1: "836570928", 2: "902099405" };

function fixture(t) {
	const dir = mkdtempSync(join(tmpdir(), "reload-saves-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const put = (name, text) => { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), text); };
	const copy = (name, as = name) => { mkdirSync(dirname(join(dir, as)), { recursive: true }); copyFileSync(new URL(name, repo), join(dir, as)); };
	copy("tools/shared/instance-identity.ps1");
	copy("tools/clusterio/reload-saves.ps1");
	copy("tools/shared/cluster-utils.ps1", "tools/shared/cluster-utils.real.ps1");
	copy("tools/shared/version-utils.ps1", "tools/shared/version-utils.real.ps1");
	put("tools/shared/cluster-utils.ps1", `. "$PSScriptRoot/cluster-utils.real.ps1"
function Assert-DevelopmentClusterCheckout {}
function Sync-ControllerWebBundle { $global:calls.Add(@('sync-web')) }
`);
	put("tools/shared/version-utils.ps1", `. "$PSScriptRoot/version-utils.real.ps1"
function Update-ModuleBuildStamp { return ('a' * 32) }
function Test-ModuleDeploymentResponse { return $true }
`);
	put("tools/shared/workflow-lock.ps1", "function Invoke-WorkflowLock { param([scriptblock]$Action) & $Action }");
	put("docker/seed-data/external_plugins/surface_export/module/module.json", '{"version":"1.0.0"}');
	return dir;
}

function run(dir, { stopIgnored = false } = {}) {
	const command = `
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$ErrorActionPreference='Stop'
$global:calls=[Collections.Generic.List[object]]::new()
$global:state = @{}
function Start-Sleep {}
function node { $global:calls.Add(@(@('node') + @(foreach ($a in $args) { "$a" }))); $global:LASTEXITCODE = 0 }
$global:clock = [datetime]'2026-10-03T00:00:00'
function Get-Date { param([string]$Format) if ($Format) { return $global:clock.ToString($Format) } $global:clock = $global:clock.AddSeconds(5); return $global:clock }
function Get-StubState { param($Id) if ($global:state.ContainsKey($Id)) { $global:state[$Id] } else { 'running' } }
function docker {
 $argv = @(foreach ($a in $args) { foreach ($b in @($a)) { "$b" } })
 $global:calls.Add($argv); $global:LASTEXITCODE=0
 $j = $argv -join ' '
 if ($argv[0] -eq 'restart') { return }
 if ($j -match 'instance\\.json') { $n = $argv[1] -replace '\\D', ''; return "/clusterio/data/instances/clusterio-host-$n-instance-1/instance.json\`t{""instance.id"": $(@{ '1' = ${IDS[1]}; '2' = ${IDS[2]} }[$n])}" }
 if ($argv[2] -eq 'sh' -and $argv[4] -match 'config\\.ini') { $id = @{ '1' = '${IDS[1]}'; '2' = '${IDS[2]}' }[$argv[1] -replace '\\D', '']; if ((Get-StubState $id) -ne 'stopped') { return '2968' } return }
 if ($argv[2] -eq 'sh' -and $argv[4] -match 'Starting RCON interface') { return }
 if ($j -match 'instance stop (\\d+)') { if ($env:SE_STOP_IGNORED -ne '1') { $global:state[$Matches[1]] = 'stopped' } return }
 if ($j -match 'instance config list') { return @('factorio.enable_save_patching true', 'instance.auto_start true') }
 if ($j -match 'instance list') { return @('name | id | assignedHost | gamePort | status', '---', "Dev One | ${IDS[1]} | 1 | 34100 | $(Get-StubState '${IDS[1]}')", "Dev Two | ${IDS[2]} | 2 | 34200 | $(Get-StubState '${IDS[2]}')") }
 if ($j -match 'stat -c') { return '1048576' }
 if ($j -match 'send-rcon') { return '' }
}
$failure=$null
try { & $env:RS_SCRIPT *>&1 | Out-Null } catch { $failure=$_.Exception.Message }
@{calls=@($global:calls | ForEach-Object { ,@($_) });error=$failure} | ConvertTo-Json -Compress -Depth 5
`;
	const result = spawnSync("pwsh", ["-NoProfile", "-Command", command], { cwd: dir, encoding: "utf8", timeout: 60_000,
		env: { ...process.env, RS_SCRIPT: join(dir, "tools/clusterio/reload-saves.ps1"), SE_STOP_IGNORED: stopIgnored ? "1" : "0" } });
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
}

const joined = calls => calls.map(argv => argv.join(" "));

test("a preserving reload waits until both instances report stopped before the hosts restart", { skip }, t => {
	const result = run(fixture(t));
	assert.equal(result.error, null);
	const calls = joined(result.calls);
	const restart = calls.indexOf("restart surface-export-host-1 surface-export-host-2");
	assert.ok(restart >= 0, JSON.stringify(calls));
	const stops = calls.map((c, i) => [c, i]).filter(([c]) => / instance stop \d+$/.test(c));
	assert.equal(stops.length, 2, JSON.stringify(calls));
	for (const id of Object.values(IDS)) {
		assert.ok(stops.some(([c]) => c.includes("timeout -k 10 420") && c.endsWith(`instance stop ${id}`)), `${id} is stopped through the bounded stop: ${JSON.stringify(calls)}`);
	}
	const lastStop = Math.max(...stops.map(([, i]) => i));
	assert.ok(calls.slice(lastStop + 1, restart).some(c => c.includes("instance list")), "the stopped state is read back before the hosts restart");
	assert.ok(calls.indexOf("sync-web") > lastStop && restart > lastStop, "nothing restarts before the instances are stopped");
});

test("a stop that never completes fails the reload before any host restart", { skip }, t => {
	const result = run(fixture(t), { stopIgnored: true });
	assert.match(result.error || "", /did not stop within 420s/);
	const calls = joined(result.calls);
	assert.equal(calls.some(c => c.startsWith("restart") || c === "sync-web"), false, JSON.stringify(calls));
});
