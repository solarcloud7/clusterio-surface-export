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

// ── Rules 1 and 2 apply to BOTH runner dialects ──────────────────────────────
// These rules were ps1-only because the guard predated mjs runners. Measured when extending: zero of
// the six current mjs runners trips either rule, so there is no live subject — which is exactly why
// each rule below is proven to FIRE on a synthetic violator and to STAY SILENT on a compliant one.
// A preventative rule nobody has watched fire is indistinguishable from one that does not work.

async function mjsViolations(source, name = "fixture") {
	const { findGroundingViolations } = await import(scriptUrl);
	return findGroundingViolations([
		{ name, dialect: "mjs", path: `tests/integration/${name}/run-tests.mjs`, source },
	]);
}

test("Rule 1 fires on a fidelity-named mjs suite with no physical count", async () => {
	const violations = await mjsViolations(
		"const res = await runBoard(2, 'return remote.call(\"x\",\"y\")');\n",
		"transfer-fidelity",
	);
	assert.equal(violations.length, 1);
	assert.equal(violations[0].rule, 1);
});

test("Rule 1 is satisfied by an independent physical count in an mjs suite", async () => {
	const violations = await mjsViolations(
		"const n = await runBoard(2, 'return surface.get_item_count(\"iron-plate\")');\n",
		"transfer-fidelity",
	);
	assert.deepEqual(violations, []);
});

test("Rule 2 fires when an mjs suite reads a self-report field with no physical count", async () => {
	const violations = await mjsViolations("const loss = result.totalItemLoss;\n");
	assert.equal(violations.length, 1);
	assert.equal(violations[0].rule, 2);
});

test("Rule 2 is satisfied when the self-report is corroborated by a physical count", async () => {
	const violations = await mjsViolations(
		"const loss = result.totalItemLoss;\nconst n = await runBoard(2, 'return s.get_item_count(\"x\")');\n",
	);
	assert.deepEqual(violations, []);
});

test("an mjs // comment is not mistaken for code", async () => {
	// The ps1 stripper cuts at `#`, which in JavaScript would truncate real lines and could HIDE a
	// marker. The mjs stripper removes `//` lines, so a marker that exists only in a comment must not
	// satisfy a rule.
	const violations = await mjsViolations(
		"const loss = result.totalItemLoss;\n// get_item_count( is only mentioned here, in a comment\n",
	);
	assert.equal(violations.length, 1, "a commented-out physical count must not satisfy rule 2");
	assert.equal(violations[0].rule, 2);
});

test("the allow marker still exempts an mjs runner", async () => {
	const violations = await mjsViolations(
		"// lint-test-grounding:allow\nconst loss = result.totalItemLoss;\n",
	);
	assert.deepEqual(violations, []);
});
