const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const pluginRoot = path.resolve(__dirname, "..");

function findRepoRoot() {
	let dir = pluginRoot;
	for (let depth = 0; depth < 8; depth++) {
		if (fs.existsSync(path.join(dir, "tests/integration/destination-hold/run-tests.ps1"))) {
			return dir;
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

const repoRoot = findRepoRoot();

function read(relPath) {
	return fs.readFileSync(path.join(pluginRoot, relPath), "utf8");
}

function readRepo(relPath) {
	if (!repoRoot) throw new Error("repo-level integration harness is not mounted in this runtime");
	return fs.readFileSync(path.join(repoRoot, relPath), "utf8");
}

function repoOnlyTest(name, fn) {
	test(name, { skip: repoRoot ? false : "repo-level integration harness is not mounted in this runtime" }, fn);
}

test("destination hold primitive is registered for explicit proof runs", () => {
	const remote = read("module/interfaces/remote-interface.lua");
	assert.match(remote, /require\("modules\/surface_export\/interfaces\/remote\/destination-hold"\)/);
	assert.match(remote, /\bdestination_hold = destination_hold\b/);
	assert.match(remote, /\bdestination_hold_json = Base\.json_wrap\(destination_hold\)/);
});

test("destination hold primitive exposes stage, go_live, discard, and get", () => {
	const hold = read("module/core/destination-hold.lua");
	assert.match(hold, /function DestinationHold\.stage\(transfer_id, platform, force\)/);
	assert.match(hold, /function DestinationHold\.go_live\(transfer_id\)/);
	assert.match(hold, /function DestinationHold\.discard\(transfer_id\)/);
	assert.match(hold, /function DestinationHold\.get\(transfer_id\)/);
	assert.match(hold, /storage\.destination_holds/);
});


test("discard treats an already-missing held platform as cleaned up", () => {
	const hold = read("module/core/destination-hold.lua");
	assert.match(hold, /if err == "Held platform is missing" then[\s\S]*holds\[transfer_id\] = nil[\s\S]*deleted = false/);
});

test("stage first moves the platform toward not-live, then deactivates entities under pcall", () => {
	const hold = read("module/core/destination-hold.lua");
	const pcallAt = hold.indexOf("local staged_ok, staged_err = pcall(function()");
	const pauseAt = hold.indexOf("platform.paused = true", pcallAt);
	const hiddenAt = hold.indexOf("force.set_surface_hidden(surface, true)", pcallAt);
	const deactivateAt = hold.indexOf("capture_and_deactivate(surface)", pcallAt);
	const errorLogAt = hold.indexOf("[DestinationHold] stage failed");

	assert.notEqual(pauseAt, -1);
	assert.notEqual(hiddenAt, -1);
	assert.notEqual(deactivateAt, -1);
	assert.notEqual(pcallAt, -1);
	assert.notEqual(errorLogAt, -1);
	assert.ok(pauseAt < deactivateAt, "stage must pause before deactivating entities");
	assert.ok(hiddenAt < deactivateAt, "stage must hide before deactivating entities");
	assert.ok(pcallAt < pauseAt, "stage mutation block must be pcall-guarded");
	assert.ok(errorLogAt > pcallAt, "stage pcall failure must be surfaced to logs");
});

test("destination hold platform lookup uses direct force platform index access", () => {
	const hold = read("module/core/destination-hold.lua");
	const remote = read("module/interfaces/remote/destination-hold.lua");
	assert.match(hold, /force\.platforms\[platform_index\]/);
	assert.doesNotMatch(hold, /for\s+_,\s*platform\s+in\s+pairs\(force\.platforms\)/);
	assert.match(remote, /force\.platforms\[idx\]/);
	assert.doesNotMatch(remote, /for\s+_,\s*platform\s+in\s+pairs\(force\.platforms\)/);
});
test("normal transfer import path is not yet gated on destination hold", () => {
	const importCompletion = read("module/core/import-completion.lua");
	assert.doesNotMatch(importCompletion, /DestinationHold/);
	assert.match(importCompletion, /Platform .* UNPAUSED after successful validation/);
});
repoOnlyTest("destination hold integration probe counts assertions dynamically", () => {
	const script = readRepo("tests/integration/destination-hold/run-tests.ps1");
	assert.doesNotMatch(script, /\$total\s*=\s*12/);
	assert.match(script, /\$script:total\+\+/);
});

repoOnlyTest("destination hold integration probe polls RCON readiness after restart", () => {
	const script = readRepo("tests/integration/destination-hold/run-tests.ps1");
	assert.match(script, /function Wait-ForRconReady/);
	assert.match(script, /Wait-ForRconReady -Instance \$instance/);
	assert.doesNotMatch(script, /Start-Sleep -Seconds \$RestartWaitSec\s*\r?\n\s*\$afterRestart = Get-Metrics/);
});

repoOnlyTest("destination hold integration probe asserts save and hold stage results", () => {
	const script = readRepo("tests/integration/destination-hold/run-tests.ps1");
	assert.match(script, /dh-server-save-ok/);
	assert.doesNotMatch(script, /Send-Rcon -Instance \$instance -Command "\/server-save" \| Out-Null/);
	assert.doesNotMatch(script, /Invoke-HoldJson -Action stage -TransferId \$ttlTid -PlatformIndex \$ttl\.Index \| Out-Null/);
});
repoOnlyTest("destination hold integration probe scopes parsed RCON responses to surface-export stdout", () => {
	const script = readRepo("tests/integration/destination-hold/run-tests.ps1");
	assert.match(script, /function Invoke-ScopedRcon/);
	assert.match(script, /docker exec surface-export-controller npx clusterioctl/);
	assert.match(script, /2>\$stderrPath/);
	assert.match(script, /Invoke-ScopedRcon -Instance \$Instance -Command "\/server-save"/);
});

repoOnlyTest("destination hold integration probe supports section selection", () => {
	const script = readRepo("tests/integration/destination-hold/run-tests.ps1");
	assert.match(script, /\[string\[\]\]\$Sections = @\("all"\)/);
	assert.match(script, /function Test-Section/);
	assert.match(script, /Test-Section "ttl"/);
	assert.match(script, /Test-Section "discard"/);
});

repoOnlyTest("destination hold integration probe cleans leaked hold records", () => {
	const script = readRepo("tests/integration/destination-hold/run-tests.ps1");
	assert.match(script, /function Clear-DestinationHoldRecords/);
	assert.match(script, /storage\.destination_holds/);
	assert.match(script, /remote\.call\('surface_export', 'destination_hold', 'discard'/);
});
repoOnlyTest("destination hold integration probe keeps tail sections cheap", () => {
	const script = readRepo("tests/integration/destination-hold/run-tests.ps1");
	assert.match(script, /function New-BareHoldPlatform/);
	assert.match(script, /force\.create_space_platform/);
	assert.match(script, /platform\.apply_starter_pack\(\)/);
	assert.match(script, /\$missing = New-BareHoldPlatform/);
	assert.match(script, /\$ttl = New-BareHoldPlatform/);
	assert.doesNotMatch(script, /\$missing = New-HoldClone/);
	assert.doesNotMatch(script, /\$ttl = New-HoldClone/);
});

repoOnlyTest("destination hold integration probe reports required zero-state evidence", () => {
	const script = readRepo("tests/integration/destination-hold/run-tests.ps1");
	assert.match(script, /dh-cleanup-no-hold-records/);
	assert.match(script, /storage\.destination_holds empty/);
	assert.match(script, /dh-cleanup-no-lock-records/);
	assert.match(script, /storage\.locked_platforms empty/);
	assert.match(script, /dh-cleanup-no-surfaces/);
	assert.match(script, /dh-cleanup-game-unpaused/);
	assert.match(script, /Set-GamePaused -Pause \$false/);
});

repoOnlyTest("destination hold integration probe records TTL expiry as the measured unhide hazard", () => {
	const script = readRepo("tests/integration/destination-hold/run-tests.ps1");
	assert.match(script, /dh-ttl-expiry-unhides-held-surface/);
	assert.match(script, /dh-ttl-expire-ok/);
	assert.match(script, /expires_tick=game.tick - 1/);
	assert.match(script, /\$ttlMetrics\.hidden -eq \$false/);
	assert.doesNotMatch(script, /dh-ttl-does-not-unhide/);
});
