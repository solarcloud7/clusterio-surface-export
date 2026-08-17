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


async function mjsRule3(source) {
	const { findMjsGroundingViolations } = await import(scriptUrl);
	return findMjsGroundingViolations([
		{ name: "fixture", dialect: "mjs", path: "tests/integration/fixture/run-tests.mjs", source },
	]);
}

const RENAMED_HELPER_FETCH = [
	"function readDestImportResult() {",
	"\tconst file = sh(`ls -t ${DST_SCRIPT_OUTPUT}/debug_import_result_*.json | head -1`);",
	"\treturn JSON.parse(sh(`cat '${file}'`));",
	"}",
	"const verdict = readDestImportResult();",
].join("\n");

const RENAMED_HELPER_DEST_READS = [
	"const atArrival = rconJson(DST_INSTANCE, platformStateLua(probe));",
	"check(atArrival.paused === arm.armed, 'the destination arrives paused');",
].join("\n");

test("Rule 3 fires on a renamed import-result helper that never adjudicates the verdict", async () => {
	const violations = await mjsRule3(`${RENAMED_HELPER_FETCH}\n${RENAMED_HELPER_DEST_READS}\n`);
	assert.equal(violations.length, 1);
	assert.equal(violations[0].rule, 3);
	assert.match(violations[0].message, /never adjudicates validation_success/);
});

test("Rule 3 accepts a renamed import-result helper that adjudicates the verdict", async () => {
	const violations = await mjsRule3(
		`${RENAMED_HELPER_FETCH}\n`
		+ "check(verdict !== null && verdict.validation_success === true, 'the exact gate passed');\n"
		+ `${RENAMED_HELPER_DEST_READS}\n`,
	);
	assert.deepEqual(violations, []);
});

test("Rule 3 fires on a renamed helper whose only verdict mention precedes the fetch", async () => {
	const violations = await mjsRule3(
		"const stale = previous.validation_success;\n"
		+ `${RENAMED_HELPER_FETCH}\n${RENAMED_HELPER_DEST_READS}\n`,
	);
	assert.equal(violations.length, 1);
	assert.match(violations[0].message, /never adjudicates validation_success/);
});

test("Rule 3 fires on the shared-helper path that fetches a result and never adjudicates it", async () => {
	const violations = await mjsRule3(
		"const { result } = await L.waitForImportResult(2, marker);\n"
		+ "step('transfer.arrived', result.platform_name === PROBE);\n",
	);
	assert.equal(violations.length, 1);
	assert.match(violations[0].message, /never adjudicates validation_success/);
});

test("Rule 3 still accepts the shared-helper path with the verdict before the board", async () => {
	const violations = await mjsRule3(
		"const { result } = await L.waitForImportResult(2, marker);\n"
		+ "step('transfer.gate', result.validation_success === true);\n"
		+ "const boardC = runBoard(2);\n",
	);
	assert.deepEqual(violations, []);
});

test("Rule 3 still fires on the shared-helper path with the board before the verdict", async () => {
	const violations = await mjsRule3(
		"const { result } = await L.waitForImportResult(2, marker);\n"
		+ "const boardC = runBoard(2);\n"
		+ "step('transfer.gate', result.validation_success === true);\n",
	);
	assert.equal(violations.length, 1);
	assert.match(violations[0].message, /before any destination board\/census/);
});

test("Rule 3 orders against the EARLIEST destination board marker, not the first one listed", async () => {
	const violations = await mjsRule3(
		"const { result } = await L.waitForImportResult(2, marker);\n"
		+ "const before = census(2);\n"
		+ "step('transfer.gate', result.validation_success === true);\n"
		+ "const boardC = runBoard(2);\n",
	);
	assert.equal(violations.length, 1);
	assert.match(violations[0].message, /before any destination board\/census/);
});

test("Rule 3 does not order against an arrival poll of the destination", async () => {
	const violations = await mjsRule3(
		"while (Date.now() < deadline) {\n"
		+ "\tconst dst = rconJson(DST_INSTANCE, platformStateLua(probe));\n"
		+ "\tif (dst.present && !rconJson(SRC_INSTANCE, platformStateLua(probe)).present) "
		+ "{ arrived = dst; break; }\n"
		+ "}\n"
		+ `${RENAMED_HELPER_FETCH}\n`
		+ "check(verdict.validation_success === true, 'the exact gate passed');\n"
		+ "check(arrived.paused === true, 'the destination arrives paused');\n",
	);
	assert.deepEqual(violations, []);
});

test("Rule 3 is not triggered by a debug_import_result mention in a comment", async () => {
	const violations = await mjsRule3(
		"// produces: the gate verdict parsed from debug_import_result before any destination read\n"
		+ "const boardC = runBoard(2);\n",
	);
	assert.deepEqual(violations, []);
});

test("the allow marker exempts an mjs runner from Rule 3", async () => {
	const violations = await mjsRule3(
		`// lint-test-grounding:allow\n${RENAMED_HELPER_FETCH}\n${RENAMED_HELPER_DEST_READS}\n`,
	);
	assert.deepEqual(violations, []);
});


const PHYSICAL = "const n = await runBoard(2, 'return s.get_item_count(\"x\")');\n";
const SELF_REPORT = "const loss = result.totalItemLoss;\n";

test("the instruments scan takes every .mjs/.ps1 except the offline *.test.mjs unit tests", async () => {
	const { isScannedInstrumentFile } = await import(scriptUrl);
	for (const name of ["run-rung.mjs", "run-tests.mjs", "run-tests.ps1", "run-pause-rung.mjs", "sweep-model.mjs"]) {
		assert.equal(isScannedInstrumentFile(name), true, `${name} must be scanned`);
	}
	for (const name of ["sweep-model.test.mjs", "registration.test.mjs", "universe.json", "prototype-dump.json"]) {
		assert.equal(isScannedInstrumentFile(name), false, `${name} must not be scanned`);
	}
});

test("a file loose in the instruments root is its own unit, not silently unscanned", async () => {
	const { instrumentUnitName } = await import(scriptUrl);
	assert.equal(instrumentUnitName("tests/instruments/one-of-each/run-rung.mjs"), "one-of-each");
	assert.equal(instrumentUnitName("tests/instruments/belt-freeze/nested/probe.mjs"), "belt-freeze");
	assert.equal(instrumentUnitName("tests/instruments/loose-fidelity-probe.mjs"), "loose-fidelity-probe.mjs");
});

async function unitViolations(files) {
	const { findGroundingViolations } = await import(scriptUrl);
	return findGroundingViolations(files);
}

function instrumentFile(fileName, source, unit = "tests/instruments/probe-fidelity") {
	return { name: unit.split("/").at(-1), unit, dialect: "mjs", path: `${unit}/${fileName}`, source };
}

test("Rule 1 is satisfied by a physical count anywhere in the instrument directory", async () => {
	const violations = await unitViolations([
		instrumentFile("run-rung.mjs", "const board = await runBoard(2);\n"),
		instrumentFile("probe.mjs", PHYSICAL),
	]);
	assert.deepEqual(violations, []);
});

test("Rule 1 reports an ungrounded instrument directory once, not once per file", async () => {
	const violations = (await unitViolations([
		instrumentFile("run-rung.mjs", "const board = await runBoard(2);\n"),
		instrumentFile("probe.mjs", "export const LUA = 'return 1';\n"),
	])).filter((entry) => entry.rule === 1);
	assert.equal(violations.length, 1);
	assert.equal(violations[0].path, "tests/instruments/probe-fidelity");
});

test("Rule 2 stays per-file — a sibling's physical count does not corroborate a self-report read", async () => {
	const violations = (await unitViolations([
		instrumentFile("run-rung.mjs", SELF_REPORT),
		instrumentFile("probe.mjs", PHYSICAL),
	])).filter((entry) => entry.rule === 2);
	assert.equal(violations.length, 1);
	assert.equal(violations[0].path, "tests/instruments/probe-fidelity/run-rung.mjs");
});

test("same-named directories under the two roots are separate units", async () => {
	const violations = (await unitViolations([
		instrumentFile("run-tests.mjs", PHYSICAL, "tests/integration/shared-fidelity"),
		instrumentFile("run-rung.mjs", "const board = await runBoard(2);\n", "tests/instruments/shared-fidelity"),
	])).filter((entry) => entry.rule === 1);
	assert.equal(violations.length, 1);
	assert.equal(violations[0].path, "tests/instruments/shared-fidelity");
});
