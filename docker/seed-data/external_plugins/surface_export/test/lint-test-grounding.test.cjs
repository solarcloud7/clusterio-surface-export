"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const scriptUrl = pathToFileURL(path.join(__dirname, "..", "scripts", "lint-test-grounding.mjs")).href;

async function rule3(source) {
	const { findGroundingViolations } = await import(scriptUrl);
	return findGroundingViolations([{ name: "fixture", path: "tests/integration/fixture/run-tests.ps1", source }])
		.filter((entry) => entry.rule === 3);
}

test("Rule 3 rejects destination census before verdict adjudication", async () => {
	const violations = await rule3(`
		$files = Get-DebugFiles -Pattern "debug_import_result_fixture_*.json"
		$result = Read-DebugFile -Filename $files[0]
		$dest = Count-Items -Instance $destInstance -PlatformName $name
		Assert-TransferSucceeded -Result $result -Context "fixture"
	`);
	assert.equal(violations.length, 1);
});

test("Rule 3 rejects debug-file existence without parsing before destination census", async () => {
	const violations = await rule3(`
		$files = Get-DebugFiles -Pattern "debug_import_result_fixture_*.json"
		if (-not $files) { throw "missing" }
		$dest = Count-Item $dstSel $name
	`);
	assert.equal(violations.length, 1);
});

test("Rule 3 accepts read then success assertion then destination census", async () => {
	const violations = await rule3(`
		$files = Get-DebugFiles -Pattern "debug_import_result_fixture_*.json"
		$result = Read-DebugFile -Filename $files[0]
		Assert-TransferSucceeded -Result $result -Context "fixture"
		$dest = Count-Items -Instance $destInstance -PlatformName $name
	`);
	assert.deepEqual(violations, []);
});

test("Rule 3 ignores expected-failure workflows that never census the destination", async () => {
	const violations = await rule3(`
		$files = Get-DebugFiles -Pattern "debug_import_result_fixture_*.json"
		$result = Read-DebugFile -Filename $files[0]
		if ($result.validation_success -eq $false) { Write-Output "expected" }
	`);
	assert.deepEqual(violations, []);
});
