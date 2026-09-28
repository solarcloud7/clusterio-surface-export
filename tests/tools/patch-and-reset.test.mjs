import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

function run(dir, { uploaded = { 1: "lab-gallery-source-4.zip", 2: "lab-gallery-destination-4.zip" }, loaded = uploaded, uploadExit = 0, autoStarted = false, staleReads = 0,
	journals = [], archiveFails = false, readinessExit = 0 } = {}) {
	const command = `
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$ErrorActionPreference='Stop'
$global:calls=[Collections.Generic.List[object]]::new()
$global:uploaded = ConvertFrom-Json $env:SE_UPLOADED -AsHashtable
$global:loaded = ConvertFrom-Json $env:SE_LOADED -AsHashtable
function Start-Sleep {}
function node { $global:calls.Add(@(@('node') + @(foreach ($a in $args) { "$a" }))); $global:LASTEXITCODE = [int]$env:SE_READINESS_EXIT }
$global:reads = @{}
$global:clock = [datetime]'2026-09-27T00:00:00'
function Get-Date { param([string]$Format) if ($Format) { return $global:clock.ToString($Format) } $global:clock = $global:clock.AddSeconds(5); return $global:clock }
function docker {
 $argv = @(foreach ($a in $args) { foreach ($b in @($a)) { "$b" } })
 $global:calls.Add($argv); $global:LASTEXITCODE=0
 $j = $argv -join ' '
 if ($argv[0] -eq 'ps') { return 'Up 5 minutes (healthy)' }
 if ($j -match 'surface_export_source_retirements\\.json') {
  if ($env:SE_ARCHIVE_FAIL -eq '1') { $global:LASTEXITCODE = 1; return 'mv: cannot move: Permission denied' }
  if (($env:SE_JOURNALS -split ',') -contains ($argv[1] -replace '\\D', '')) { return 'archived' }
  return 'absent'
 }
 if ($env:SE_AUTO_STARTED -eq '1' -and $j -match 'instance start') { $global:LASTEXITCODE = 1; return 'Error sending request: Instance is already running.' }
 if ($j -match 'instance save list (\\d+)') {
  $id = $Matches[1]
  $global:reads[$id] = 1 + [int]$global:reads[$id]
  if ($global:reads[$id] -le [int]$env:SE_STALE_READS) { return @('instanceId | type | name | size | loaded | loadByDefault', '---', "$id | file | lab-gallery-source.zip | 1 | false | false") }
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
$global:output=[Collections.Generic.List[string]]::new()
try { & $env:PAR_SCRIPT -LuaOnly -SkipIncrement *>&1 | ForEach-Object { $global:output.Add("$_") } } catch { $failure=$_.Exception.Message }
@{calls=@($global:calls | ForEach-Object { ,@($_) });error=$failure;output=@($global:output)} | ConvertTo-Json -Compress -Depth 5
`;
	const result = spawnSync("pwsh", ["-NoProfile", "-Command", command], { cwd: dir, encoding: "utf8", timeout: 60_000,
		env: { ...process.env, PAR_SCRIPT: join(dir, "tools/clusterio/patch-and-reset.ps1"),
			PAR_BUILD_FILE: join(dir, "docker/seed-data/external_plugins/surface_export/module/build-id.lua"),
			SE_UPLOADED: JSON.stringify({ [IDS[1]]: uploaded[1], [IDS[2]]: uploaded[2] }),
			SE_LOADED: JSON.stringify({ [IDS[1]]: loaded[1], [IDS[2]]: loaded[2] }), SE_UPLOAD_EXIT: String(uploadExit), SE_AUTO_STARTED: autoStarted ? "1" : "0", SE_STALE_READS: String(staleReads),
				SE_JOURNALS: journals.join(","), SE_ARCHIVE_FAIL: archiveFails ? "1" : "0", SE_READINESS_EXIT: String(readinessExit) } });
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
}

const ALLOWED = ["instance list", "instance save list", "instance save upload", "instance start", "instance stop",
	"instance config set", "instance send-rcon"];
const deletes = calls => calls.filter(argv => argv.some(arg => /(^|\s)(find|rm|-delete)(\s|$)/.test(arg))
	|| (argv.includes("clusterioctl") && !ALLOWED.some(command => `${argv.join(" ")} `.includes(` ${command} `))));

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

test("an instance auto-started on the uploaded save passes; one auto-started on another save fails", { skip }, t => {
	const passed = run(fixture(t), { autoStarted: true });
	assert.equal(passed.error, null);
	assert.equal(passed.calls.filter(argv => argv.includes("start")).length, 2);
	assert.deepEqual(deletes(passed.calls), []);
	const failed = run(fixture(t), { autoStarted: true, loaded: { 1: "2026-09-27 1140 _autosave2.zip", 2: "lab-gallery-destination-4.zip" } });
	assert.match(failed.error || "", /Dev One is running '2026-09-27 1140 _autosave2\.zip', not the uploaded seed save 'lab-gallery-source-4\.zip', after 90s/);
});

test("a save list that briefly shows nothing loaded is polled until the uploaded save appears", { skip }, t => {
	const result = run(fixture(t), { autoStarted: true, staleReads: 2 });
	assert.equal(result.error, null);
	assert.equal(result.calls.filter(argv => argv.includes("list") && argv.includes("save")).length, 6);
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
	assert.match(result.error || "", /Dev Two is running '2026-09-27 1140 _autosave_po3\.zip', not the uploaded seed save 'lab-gallery-destination-4\.zip', after 90s\. Nothing was deleted/);
	assert.deepEqual(deletes(result.calls), []);
});

const JOURNAL = host => `/clusterio/data/instances/clusterio-host-${host}-instance-1/surface_export_source_retirements.json`;
const archives = calls => calls.filter(argv => argv.some(arg => arg.endsWith("surface_export_source_retirements.json")));

test("a reset archives each recovery journal by rename after the stop and before any upload or start", { skip }, t => {
	const result = run(fixture(t), { journals: [1, 2] });
	assert.equal(result.error, null);
	assert.deepEqual(deletes(result.calls), []);
	const moved = archives(result.calls);
	assert.equal(moved.length, 2);
	for (const [index, host] of [[0, 1], [1, 2]]) {
		const argv = moved[index];
		assert.deepEqual(argv.slice(0, 4), ["exec", `surface-export-host-${host}`, "sh", "-c"]);
		assert.match(argv[4], /mv "\$1" "\$2"/);
		assert.doesNotMatch(argv[4], /(^|\s)(rm|find|unlink|truncate)(\s|$)|>\s*"\$1"/);
		assert.equal(argv[5], "sh");
		assert.equal(argv[6], JOURNAL(host));
		assert.match(argv[7], new RegExp(`^/clusterio/data/instances/clusterio-host-${host}-instance-1/surface_export_source_retirements\\.\\d{8}-\\d{6}\\.bak\\.json$`));
		assert.equal(argv.length, 8);
	}
	const at = argv => result.calls.indexOf(argv);
	const lastStop = Math.max(...result.calls.filter(argv => argv.includes("stop")).map(at));
	const firstUpload = result.calls.findIndex(argv => argv.includes("upload"));
	const firstStart = result.calls.findIndex(argv => argv.includes("start"));
	assert.ok(lastStop >= 0 && at(moved[0]) > lastStop, "instances are stopped before the journal moves");
	assert.ok(at(moved[1]) < firstUpload && at(moved[1]) < firstStart, "the journal moves before any seed upload or start");
	assert.equal(result.output.filter(line => line.includes(" -> ") && line.includes(".bak.json")).length, 2);
});

test("a reset with no recovery journal archives nothing and still succeeds", { skip }, t => {
	const result = run(fixture(t));
	assert.equal(result.error, null);
	assert.equal(archives(result.calls).length, 2);
	assert.equal(result.output.filter(line => line.includes("nothing to archive")).length, 2);
	assert.equal(result.output.some(line => line.includes(".bak.json")), false);
});

test("a failed journal archive stops the reset before any upload", { skip }, t => {
	const result = run(fixture(t), { journals: [1], archiveFails: true });
	assert.match(result.error || "", /Archiving .*surface_export_source_retirements\.json on surface-export-host-1 failed \(exit 1\)/);
	assert.equal(result.calls.some(argv => argv.includes("upload")), false);
	assert.equal(result.calls.some(argv => argv.includes("start")), false);
});

test("the boot check waits for source recovery and throws when it is not ready", { skip }, t => {
	const ready = run(fixture(t));
	const readiness = ready.calls.filter(argv => argv[0] === "node");
	assert.equal(readiness.length, 1);
	assert.match(readiness[0][1], /tools[\\/]clusterio[\\/]\.\.[\\/]tests[\\/]cluster-readiness\.mjs$/);
	assert.deepEqual(readiness[0].slice(2), ["--runtime"]);
	assert.ok(ready.calls.indexOf(readiness[0]) > ready.calls.findLastIndex(argv => argv.includes("start")));
	const blocked = run(fixture(t), { readinessExit: 1 });
	assert.match(blocked.error || "", /Startup source recovery is not ready after the reset/);
});

const shell = spawnSync("sh", ["-c", "exit 0"], { stdio: "ignore" }).status === 0;

test("the archive shell step renames, never overwrites, and reports an absent journal", { skip: skip || !shell }, t => {
	const source = readFileSync(new URL("tools/clusterio/patch-and-reset.ps1", repo), "utf8");
	const script = source.match(/^\$archiveScript = '([^']+)'\r?$/m)?.[1];
	assert.ok(script, "patch-and-reset.ps1 no longer defines $archiveScript as one single-quoted line");
	const dir = mkdtempSync(join(tmpdir(), "journal archive "));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const journal = join(dir, "surface_export_source_retirements.json");
	const archive = join(dir, "surface_export_source_retirements.20260927-000000.bak.json");
	const archiveStep = () => spawnSync("sh", ["-c", script, "sh", journal, archive], { encoding: "utf8" });
	let step = archiveStep();
	assert.deepEqual([step.status, step.stdout.trim()], [0, "absent"]);
	writeFileSync(journal, '{"v":1,"id":"a","retirements":[1]}');
	step = archiveStep();
	assert.deepEqual([step.status, step.stdout.trim()], [0, "archived"]);
	assert.equal(existsSync(journal), false);
	assert.equal(readFileSync(archive, "utf8"), '{"v":1,"id":"a","retirements":[1]}');
	writeFileSync(journal, "newer");
	step = archiveStep();
	assert.equal(step.status, 3);
	assert.equal(readFileSync(journal, "utf8"), "newer");
	assert.equal(readFileSync(archive, "utf8"), '{"v":1,"id":"a","retirements":[1]}');
});
