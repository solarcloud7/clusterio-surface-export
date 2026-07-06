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


test("discard treats missing or surface-changed held platforms as cleaned up", () => {
	const hold = read("module/core/destination-hold.lua");
	assert.match(hold, /err == "Held platform is missing" or err == "Held platform surface changed or is missing"/);
	assert.match(hold, /holds\[transfer_id\] = nil[\s\S]*deleted = false/);
	assert.match(hold, /surface_changed = \(err == "Held platform surface changed or is missing"\)/);
});

test("stage first moves the platform toward not-live, then deactivates entities under pcall", () => {
	const hold = read("module/core/destination-hold.lua");
	const pcallAt = hold.indexOf("local staged_ok, staged_err = pcall(function()");
	const pauseAt = hold.indexOf("platform.paused = true", pcallAt);
	const hiddenAt = hold.indexOf("force.set_surface_hidden(surface, true)", pcallAt);
	const deactivateAt = hold.indexOf("capture_and_deactivate(surface, active_states)", pcallAt);
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
test("stage failure rolls back partial not-live mutations", () => {
	const hold = read("module/core/destination-hold.lua");
	const failureAt = hold.indexOf("if not staged_ok then");
	const returnAt = hold.indexOf("return false, \"Failed to stage destination hold", failureAt);
	const failureBlock = hold.slice(failureAt, returnAt);

	assert.notEqual(failureAt, -1);
	assert.notEqual(returnAt, -1);
	assert.match(hold, /function capture_and_deactivate\(surface, active_states\)/);
	assert.match(hold, /deactivated = capture_and_deactivate\(surface, active_states\)/);
	assert.doesNotMatch(hold, /active_states, deactivated = capture_and_deactivate/);
	assert.match(failureBlock, /restore_active_states\(surface, active_states\)/);
	assert.match(failureBlock, /force\.set_surface_hidden\(surface, original_hidden == true\)/);
	assert.match(failureBlock, /platform\.paused = original_paused == true/);
	assert.match(failureBlock, /stage rollback failed/);
});

test("destination hold platform lookup uses direct force platform index access", () => {
	const hold = read("module/core/destination-hold.lua");
	const remote = read("module/interfaces/remote/destination-hold.lua");
	assert.match(hold, /force\.platforms\[platform_index\]/);
	assert.doesNotMatch(hold, /for\s+_,\s*platform\s+in\s+pairs\(force\.platforms\)/);
	assert.match(remote, /force\.platforms\[idx\]/);
	assert.doesNotMatch(remote, /for\s+_,\s*platform\s+in\s+pairs\(force\.platforms\)/);
});
test("stage refuses a second hold on the same platform under a different transfer id", () => {
	const hold = read("module/core/destination-hold.lua");
	assert.match(hold, /function find_hold_for_platform\(holds, surface_index, platform_index, except_transfer_id\)/);
	assert.match(hold, /find_hold_for_platform\(holds, surface\.index, platform\.index, transfer_id\)/);
	assert.match(hold, /platform is already held by transfer_id/);
});

test("destination hold remote fails loud for unknown force names", () => {
	const remote = read("module/interfaces/remote/destination-hold.lua");
	assert.match(remote, /local selected_force_name = force_name or "player"/);
	assert.match(remote, /local force = game\.forces\[selected_force_name\]/);
	assert.doesNotMatch(remote, /game\.forces\[force_name or "player"\] or game\.forces\.player/);
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
	assert.match(script, /function Get-ClusterioInstanceStatus/);
	assert.match(script, /if \(\$status -ne "running"\)/);
	assert.match(script, /Wait-ForRconReady -Instance \$instance/);
	assert.doesNotMatch(script, /Start-Sleep -Seconds \$RestartWaitSec\s*\r?\n\s*\$afterRestart = Get-Metrics/);
});

repoOnlyTest("destination hold integration probe asserts save and hold stage results", () => {
	const script = readRepo("tests/integration/destination-hold/run-tests.ps1");
	assert.match(script, /dh-server-save-ok/);
	assert.doesNotMatch(script, /Send-Rcon -Instance \$instance -Command "\/server-save" \| Out-Null/);
	assert.doesNotMatch(script, /Invoke-HoldJson -Action stage -TransferId \$ttlTid -PlatformIndex \$ttl\.Index \| Out-Null/);
});
repoOnlyTest("destination hold integration probe directly measures machine-buffer fluids", () => {
	const script = readRepo("tests/integration/destination-hold/run-tests.ps1");
	assert.match(script, /tick=game\.tick/);
	assert.match(script, /game_paused=game\.tick_paused == true/);
	assert.match(script, /platform_paused=p\.paused == true/);
	assert.match(script, /machine_fluid_total/);
	assert.match(script, /machine_fluid_direct_total/);
	assert.match(script, /machine_fluid_segment_total/);
	assert.match(script, /machine_fluid_boxes/);
	assert.match(script, /e\.type == 'assembling-machine'/);
	assert.match(script, /dh-fixture-machine-fluid-grounded/);
	assert.match(script, /heavy-oil-cracking/);
	assert.doesNotMatch(script, /solid-fuel-from-heavy-oil/);
	assert.match(script, /\$machineFluidOk/);
	assert.match(script, /game_paused \$\(\$Expected\.game_paused\)->\$\(\$Actual\.game_paused\)/);
	assert.match(script, /platform_paused \$\(\$Expected\.platform_paused\)->\$\(\$Actual\.platform_paused\)/);
	assert.match(script, /machine_fluids \$\(\$Expected\.machine_fluid_total\)->\$\(\$Actual\.machine_fluid_total\)/);
	assert.match(script, /machine_direct \$\(\$Expected\.machine_fluid_direct_total\)->\$\(\$Actual\.machine_fluid_direct_total\)/);
	assert.match(script, /machine_segment \$\(\$Expected\.machine_fluid_segment_total\)->\$\(\$Actual\.machine_fluid_segment_total\)/);
});

repoOnlyTest("destination hold integration probe scopes parsed RCON responses to surface-export stdout", () => {
	const script = readRepo("tests/integration/destination-hold/run-tests.ps1");
	assert.match(script, /function Invoke-ScopedRcon/);
	assert.match(script, /docker exec surface-export-controller npx clusterioctl/);
	assert.match(script, /2>\$stderrPath/);
	assert.match(script, /Get-Content -LiteralPath \$stderrPath -Raw -ErrorAction SilentlyContinue \| Out-String\)\.Trim\(\)/);
	assert.match(script, /\(\[string\]\(\$stdout \| Out-String\)\)\.Trim\(\)/);
	assert.match(script, /\(\[string\]\$_\)\.Trim\(\) -ne ""/);
	assert.match(script, /Invoke-ScopedRcon -Instance \$Instance -Command "\/server-save"/);
});

repoOnlyTest("destination hold integration probe supports section selection", () => {
	const script = readRepo("tests/integration/destination-hold/run-tests.ps1");
	assert.match(script, /\[string\[\]\]\$Sections = @\("all"\)/);
	assert.match(script, /function Test-Section/);
	assert.match(script, /Test-Section "ttl"/);
	assert.match(script, /Test-Section "discard"/);
	assert.match(script, /Test-Section "double"/);
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
repoOnlyTest("destination hold integration probe proves same-platform second hold refusal", () => {
	const script = readRepo("tests/integration/destination-hold/run-tests.ps1");
	assert.match(script, /dh-double-stage-first-ok/);
	assert.match(script, /dh-double-stage-refuses/);
	assert.match(script, /\$double = New-BareHoldPlatform/);
	assert.match(script, /\$secondStage\.success -eq \$false/);
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
