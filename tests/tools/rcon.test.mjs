import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const skip = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" }).status !== 0;
const repo = new URL("../../", import.meta.url);
const IDS = { 1: "836570928", 2: "902099405", 3: "117" };

function fixture(t) {
	const dir = mkdtempSync(join(tmpdir(), "rcon-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	for (const name of ["tools/clusterio/rcon.ps1", "tools/shared/cluster-utils.ps1", "tools/shared/instance-identity.ps1"]) {
		mkdirSync(dirname(join(dir, name)), { recursive: true });
		copyFileSync(new URL(name, repo), join(dir, name));
	}
	return dir;
}

function run(dir, ...args) {
	const command = `
$ErrorActionPreference='Stop'
$global:calls=[Collections.Generic.List[object]]::new()
function docker {
 $argv = @(foreach ($a in $args) { foreach ($b in @($a)) { "$b" } })
 $global:calls.Add($argv); $global:LASTEXITCODE=0
 if (($argv -join ' ') -match 'instance list') { return @('name | id | assignedHost | gamePort | status', '---', 'Dev One | ${IDS[1]} | 1 | 34100 | running', 'Dev Two | ${IDS[2]} | 2 | 34200 | running', 'Dev Three | ${IDS[3]} | 3 | 34400 | running') }
 return 'reply'
}
$failure=$null
$rconArgs = @(ConvertFrom-Json $env:RCON_ARGS)
try { & $env:RCON_SCRIPT @rconArgs | Out-Null } catch { $failure=$_.Exception.Message }
@{calls=@($global:calls | ForEach-Object { ,@($_) });error=$failure} | ConvertTo-Json -Compress -Depth 5
`;
	const result = spawnSync("pwsh", ["-NoProfile", "-Command", command], { cwd: dir, encoding: "utf8", timeout: 60_000,
		env: { ...process.env, RCON_SCRIPT: join(dir, "tools/clusterio/rcon.ps1"), RCON_ARGS: JSON.stringify(args) } });
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
}

const sent = result => result.calls.filter(argv => argv.includes("send-rcon")).map(argv => argv.slice(argv.indexOf("send-rcon") + 1, argv.indexOf("send-rcon") + 3));

test("the host shorthand resolves the instance assigned to any host number", { skip }, t => {
	const dir = fixture(t);
	for (const [target, host] of [["11", 1], ["21", 2], ["31", 3]]) {
		const result = run(dir, target, "/list-platforms");
		assert.equal(result.error, null);
		assert.deepEqual(sent(result), [[IDS[host], "/list-platforms"]]);
	}
});

test("instance ids and names pass through without a lookup", { skip }, t => {
	const dir = fixture(t);
	for (const target of [IDS[1], "Dev Two", "host-one"]) {
		const result = run(dir, target, "/sc", "rcon.print(1)");
		assert.equal(result.error, null);
		assert.equal(result.calls.some(argv => argv.includes("list")), false);
		assert.deepEqual(sent(result), [[target, "/sc rcon.print(1)"]]);
	}
});

test("a slot other than 1 is refused before any RCON command", { skip }, t => {
	const result = run(fixture(t), "12", "/list-platforms");
	assert.match(result.error || "", /Target '12' names slot 2 on host 1; each host runs one instance/);
	assert.deepEqual(result.calls, []);
});

test("a host with no assigned instance fails instead of guessing", { skip }, t => {
	const result = run(fixture(t), "41", "/list-platforms");
	assert.match(result.error || "", /Host 4 has 0 assigned instance\(s\)/);
	assert.deepEqual(sent(result), []);
});
