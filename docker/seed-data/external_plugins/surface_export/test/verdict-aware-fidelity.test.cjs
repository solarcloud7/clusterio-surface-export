"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..", "..", "..", "..");
const modulePath = path.join(repoRoot, "tests", "integration", "lib", "TestBase.psm1");
const requiredToolsAvailable = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], { stdio: "ignore" }).status === 0;
const toolSkip = requiredToolsAvailable ? false : "requires pwsh";

function runPowerShell(body) {
	return spawnSync("pwsh", ["-NoProfile", "-Command", `$ErrorActionPreference='Stop'; Import-Module '${modulePath.replaceAll("'", "''")}' -Force; ${body}`], {
		encoding: "utf8",
	});
}

test("Assert-TransferSucceeded returns only for an explicit true verdict", { skip: toolSkip }, () => {
	const result = runPowerShell(`
		$result=[pscustomobject]@{validation_success=$true};
		Assert-TransferSucceeded -Result $result -Context 'happy';
		Write-Output 'RETURNED'
	`);
	assert.equal(result.status, 0, result.stderr || result.stdout);
	assert.match(result.stdout, /RETURNED/);
});


test("Assert-TransferSucceeded rejects a non-boolean truthy verdict", { skip: toolSkip }, () => {
	const result = runPowerShell(`
		$result=[pscustomobject]@{validation_success='true'; validation_result=[pscustomobject]@{failedStage='wire_shape'}};
		try { Assert-TransferSucceeded -Result $result -Context 'wire fixture'; exit 0 }
		catch { [Console]::Error.WriteLine($_.Exception.Message); exit 7 }
	`);
	assert.equal(result.status, 7, result.stderr || result.stdout);
	assert.match(result.stderr, /validation_success=true/);
});
test("Assert-TransferSucceeded throws before census with failure diagnostics", { skip: toolSkip }, () => {
	const result = runPowerShell(`
		$result=[pscustomobject]@{
			validation_success=$false;
			validation_result=[pscustomobject]@{
				failedStage='items';
				mismatchDetails=@('processing-unit: expected 54, actual 50');
				failureBlackBox=[pscustomobject]@{file='failure_black_box_fixture.json'}
			}
		};
		try { Assert-TransferSucceeded -Result $result -Context 'ground fixture'; exit 0 }
		catch { [Console]::Error.WriteLine($_.Exception.Message); exit 7 }
	`);
	assert.equal(result.status, 7, result.stderr || result.stdout);
	assert.match(result.stderr, /ground fixture/);
	assert.match(result.stderr, /failedStage=items/);
	assert.match(result.stderr, /processing-unit/);
	assert.match(result.stderr, /failure_black_box_fixture\.json/);
});

test("migrated fidelity runners adjudicate verdict before destination census", () => {
	const cases = [
		// ground-item-fidelity retired 2026-07-19 (absorbed by the omnibus-ground-items pad —
		// tests/integration/MIGRATION.md); belt-loss-replay remains the Phase-5B instrument.
		["belt-loss-replay", "$dest = Count-ProcessingUnits"],
	];
	for (const [name, censusMarker] of cases) {
		const source = readFileSync(path.join(repoRoot, "tests", "integration", name, "run-tests.ps1"), "utf8");
		const readIndex = source.indexOf("Read-DebugFile");
		const assertIndex = source.indexOf("Assert-TransferSucceeded");
		const censusIndex = source.indexOf(censusMarker);
		assert.ok(readIndex >= 0, `${name} must parse the debug result`);
		assert.ok(assertIndex > readIndex, `${name} must assert success after parsing`);
		assert.ok(censusIndex > assertIndex, `${name} must assert success before destination census`);
	}
});
