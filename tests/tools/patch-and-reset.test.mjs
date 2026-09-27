import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const skip = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" }).status !== 0;
const repo = new URL("../../", import.meta.url);
const IDS = { 1: "836570928", 2: "902099405" };
const CTL = ["exec", "surface-export-controller", "npx", "clusterioctl", "--config", "/clusterio/tokens/config-control.json"];

function fixture(t, script = process.env.PATCH_AND_RESET_UNDER_TEST) {
	const dir = mkdtempSync(join(tmpdir(), "patch-and-reset-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const put = (name, text) => { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), text); };
	const copy = name => { mkdirSync(dirname(join(dir, name)), { recursive: true }); copyFileSync(new URL(name, repo), join(dir, name)); };
	for (const name of ["tools/shared/instance-identity.ps1", "tools/shared/version-utils.ps1", "tools/shared/cluster-utils.ps1"]) copy(name);
	if (script) { mkdirSync(join(dir, "tools/clusterio"), { recursive: true }); copyFileSync(script, join(dir, "tools/clusterio/patch-and-reset.ps1")); }
	else copy("tools/clusterio/patch-and-reset.ps1");
	writeFileSync(join(dir, "tools/shared/cluster-utils.ps1"), `. "$PSScriptRoot/cluster-utils.real.ps1"
function Assert-DevelopmentClusterCheckout {}
function Update-PackageLockVersion {}
function Update-ModuleVersionStamp {}
`);
	copyFileSync(new URL("tools/shared/cluster-utils.ps1", repo), join(dir, "tools/shared/cluster-utils.real.ps1"));
	put("tools/shared/workflow-lock.ps1", "function Invoke-WorkflowLock { param([scriptblock]$Action) & $Action }");
	const plugin = "docker/seed-data/external_plugins/surface_export";
	put(`${plugin}/package.json`, '{"version":"1.0.0"}');
	put(`${plugin}/module/module.json`, '{"version":"1.0.0"}');
	put(`${plugin}/lib/a.ts`, "");
	put(`${plugin}/web/b.tsx`, "");
	put(`${plugin}/dist/node/a.js`, "");
	put(`${plugin}/dist/web/b.js`, "");
	const past = new Date(Date.now() - 3_600_000);
	for (const name of [`${plugin}/lib/a.ts`, `${plugin}/web/b.tsx`]) utimesSync(join(dir, name), past, past);
	for (const [host, save] of [[1, "lab-gallery-source.zip"], [2, "lab-gallery-destination.zip"]]) {
		put(`docker/seed-data/hosts/clusterio-host-${host}/clusterio-host-${host}-instance-1/${save}`, "");
	}
	return dir;
}

function run(dir, { uploaded = { 1: "lab-gallery-source-4.zip", 2: "lab-gallery-destination-4.zip" }, loaded = uploaded, uploadExit = 0 } = {}) {
	const command = `
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$ErrorActionPreference='Stop'
$global:calls=[Collections.Generic.List[object]]::new()
$global:uploaded = ConvertFrom-Json $env:SE_UPLOADED -AsHashtable
$global:loaded = ConvertFrom-Json $env:SE_LOADED -AsHashtable
function Start-Sleep {}
function docker {
 $argv = @(foreach ($a in $args) { foreach ($b in @($a)) { "$b" } })
 $global:calls.Add($argv); $global:LASTEXITCODE=0
 $j = $argv -join ' '
 if ($args[0] -eq 'ps') { return 'Up 5 minutes (healthy)' }
 if ($j -match 'instance save list (\\d+)') {
  $id = $Matches[1]
  return @('instanceId | type | name | size | loaded | loadByDefault', '---', "$id | file | lab-gallery-source.zip | 1 | false | false", "$id | file | $($global:loaded[$id]) | 1 | true | false")
 }
 if ($j -match 'instance list') { return @('name | id | assignedHost | gamePort | status', '---', 'Dev One | ${IDS[1]} | 1 | 34100 | running', 'Dev Two | ${IDS[2]} | 2 | 34200 | running') }
 if ($j -match 'instance\\.json') { $n = $args[1] -replace '\\D', ''; return "/clusterio/data/instances/clusterio-host-$n-instance-1/instance.json\`t{""instance.id"": $(@{ '1' = ${IDS[1]}; '2' = ${IDS[2]} }[$n])}" }
 if ($j -match 'save upload (\\d+)') {
  $global:LASTEXITCODE = [int]$env:SE_UPLOAD_EXIT
  return "[info] Successfully uploaded as $($global:uploaded[$Matches[1]])"
 }
 if ($j -match 'stat -c') { return '1048576' }
 if ($j -match 'send-rcon' -and $j -notmatch 'server_save') { $build = [regex]::Match((Get-Content $env:PAR_BUILD_FILE -Raw), '[a-f0-9]{32}').Value; return "{""version"":""1.0.0"",""buildId"":""$build""}" }
}
$failure=$null
try { & $env:PAR_SCRIPT -LuaOnly -SkipIncrement *> $null } catch { $failure=$_.Exception.Message }
@{calls=@($global:calls | ForEach-Object { ,@($_) });error=$failure} | ConvertTo-Json -Compress -Depth 5
`;
	const result = spawnSync("pwsh", ["-NoProfile", "-Command", command], { cwd: dir, encoding: "utf8", timeout: 60_000,
		env: { ...process.env, PAR_SCRIPT: join(dir, "tools/clusterio/patch-and-reset.ps1"),
			PAR_BUILD_FILE: join(dir, "docker/seed-data/external_plugins/surface_export/module/build-id.lua"),
			SE_UPLOADED: JSON.stringify({ [IDS[1]]: uploaded[1], [IDS[2]]: uploaded[2] }),
			SE_LOADED: JSON.stringify({ [IDS[1]]: loaded[1], [IDS[2]]: loaded[2] }), SE_UPLOAD_EXIT: String(uploadExit) } });
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
}

const deletes = calls => calls.filter(argv => argv.some(arg => /(^|\s)(find|rm|-delete)(\s|$)/.test(arg)));

test("a reset uploads each seed save, starts on the stored name, and deletes nothing", { skip }, t => {
	const result = run(fixture(t));
	assert.equal(result.error, null);
	assert.deepEqual(deletes(result.calls), []);
	const uploads = result.calls.filter(argv => argv.includes("upload"));
	assert.deepEqual(uploads, [
		[...CTL, "--log-level", "info", "instance", "save", "upload", IDS[1], "/clusterio/seed-data/hosts/clusterio-host-1/clusterio-host-1-instance-1/lab-gallery-source.zip"],
		[...CTL, "--log-level", "info", "instance", "save", "upload", IDS[2], "/clusterio/seed-data/hosts/clusterio-host-2/clusterio-host-2-instance-1/lab-gallery-destination.zip"],
	]);
	assert.deepEqual(result.calls.filter(argv => argv.includes("start")), [
		[...CTL, "instance", "start", IDS[1], "--save", "lab-gallery-source-4.zip"],
		[...CTL, "instance", "start", IDS[2], "--save", "lab-gallery-destination-4.zip"],
	]);
	const restart = result.calls.findIndex(argv => argv[0] === "restart");
	assert.ok(restart > result.calls.indexOf(uploads[1]), "uploads finish before the containers restart");
});

test("an upload that reports no stored name stops the reset before any restart", { skip }, t => {
	const result = run(fixture(t), { uploaded: { 1: "", 2: "" } });
	assert.match(result.error || "", /reported 0 stored save names; expected one/);
	assert.equal(result.calls.some(argv => argv[0] === "restart"), false);
	assert.deepEqual(deletes(result.calls), []);
});

test("a failed upload stops the reset with its output", { skip }, t => {
	const result = run(fixture(t), { uploadExit: 1 });
	assert.match(result.error || "", /Uploading .*lab-gallery-source\.zip to instance 836570928 failed \(exit 1\)/);
	assert.equal(result.calls.some(argv => argv[0] === "restart"), false);
});

test("an instance running a save other than the uploaded one fails the reset", { skip }, t => {
	const result = run(fixture(t), { loaded: { 1: "lab-gallery-source-4.zip", 2: "2026-09-27 1140 _autosave_po3.zip" } });
	assert.match(result.error || "", /Dev Two is running '2026-09-27 1140 _autosave_po3\.zip', not the uploaded seed save 'lab-gallery-destination-4\.zip'\. Nothing was deleted/);
	assert.deepEqual(deletes(result.calls), []);
});
