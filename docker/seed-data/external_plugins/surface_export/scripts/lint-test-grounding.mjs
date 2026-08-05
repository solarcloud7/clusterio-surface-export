#!/usr/bin/env node
/**
 * lint-test-grounding.mjs - mechanical guard for integration-test grounding.
 *
 * The recurring failure mode: a fidelity test that asserts on a value derived from the code under test
 * proves nothing. The original transfer-fidelity incident would have gone green on a broken loss meter;
 * independent physical counts and adversarial review caught it. Rule 3 closes the adjacent disposition
 * blind spot measured in W3: a success-path runner saw a failed verdict, Black-Box Discard removed the
 * destination, and the runner then misreported the missing destination as physical item loss.
 *
 * Rules per tests/integration/<name>/run-tests.{ps1,mjs}, with comments stripped (dialect-aware —
 * `#` for PowerShell, `//` for JavaScript, so a commented-out marker never satisfies a rule):
 *   1. A fidelity test performs an independent physical item count.        [both dialects]
 *   2. Validator fidelity self-reports are cross-grounded physically.      [both dialects]
 *   3. A success-path destination census follows the verdict adjudication. [dialect-specific markers:
 *      ps1 Read-DebugFile -> Assert-TransferSucceeded; mjs validation_success before any board/census]
 *
 * Rules 1 and 2 covered ps1 only until 2026-08-05, because this guard predated mjs runners. No mjs
 * runner violates them today, so their mjs coverage is preventative — which is exactly why each has a
 * self-test proving it FIRES on a synthetic violator (test/lint-test-grounding.test.cjs). A
 * preventative rule nobody has watched fire is indistinguishable from one that does not work.
 *
 * Escape hatch: lint-test-grounding:allow with an owner-approved manifest entry. An allow is an escalation,
 * never a self-service response to a firing guard.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..", "..", "..", "..", "..");
const TESTS_DIR = join(REPO_ROOT, "tests", "integration");
const ALLOW_MARKER = "lint-test-grounding:allow";
const SELF_REPORT_FIELDS = ["totalItemLoss", "expectedItemCounts", "actualItemCounts"];
const PHYSICAL_COUNT = "get_item_count(";
const DESTINATION_CENSUS_RE = /\bCount-[A-Za-z0-9_-]+\b[^\r\n]*(?:\$(?:dest|dst)\w*|-Destination(?:Instance|Host|Platform)?\b)/gi;

function stripComments(source, dialect = "ps1") {
	// Dialect-aware, because the shared rules below now run over BOTH runner kinds. Stripping from
	// `#` in a JavaScript file would truncate every line containing one (a private field, a URL
	// fragment) and could hide a marker that really is there; stripping `//` in PowerShell would do
	// nothing useful. Line comments only either way — the markers this guard looks for are code
	// identifiers, and anything cleverer risks mangling a string that merely contains one.
	if (dialect === "mjs") {
		return source.replace(/^\s*\/\/.*$/gm, "");
	}
	return source
		.split(/\r?\n/)
		.map((line) => {
			const index = line.indexOf("#");
			return index === -1 ? line : line.slice(0, index);
		})
		.join("\n");
}

function findTestFiles() {
	if (!existsSync(TESTS_DIR)) return [];
	const files = [];
	for (const name of readdirSync(TESTS_DIR)) {
		const directory = join(TESTS_DIR, name);
		if (!statSync(directory).isDirectory()) continue;
		// Both runner dialects are in scope (2026-07-28 consolidation): the ps1 rules below, and
		// the mjs verdict-before-census rule in findMjsGroundingViolations.
		for (const runner of ["run-tests.ps1", "run-tests.mjs"]) {
			const file = join(directory, runner);
			if (!existsSync(file)) continue;
			files.push({
				name,
				dialect: runner.endsWith(".mjs") ? "mjs" : "ps1",
				path: relative(REPO_ROOT, file).replace(/\\/g, "/"),
				source: readFileSync(file, "utf8"),
			});
		}
	}
	return files;
}

// mjs runners (the consolidated gallery-suite class): the disposition blind spot rule translated —
// a runner that reads debug_import_result must ADJUDICATE the verdict (validation_success) before
// any destination-side board/census call, so a refused transfer is never misread as physical loss.
export function findMjsGroundingViolations(files) {
	const violations = [];
	for (const { dialect, path, source } of files) {
		if (dialect !== "mjs" || source.includes(ALLOW_MARKER)) continue;
		const code = source.replace(/^\s*\/\/.*$/gm, "");
		const debugIndex = code.indexOf("waitForImportResult");
		if (debugIndex === -1) continue;
		const verdictIndex = code.indexOf("validation_success", debugIndex);
		const destReadIndex = (() => {
			for (const marker of ["runBoard(2", "runBoard(destHost", "Count-", "census"]) {
				const i = code.indexOf(marker, debugIndex);
				if (i !== -1) return i;
			}
			return -1;
		})();
		if (destReadIndex !== -1 && (verdictIndex === -1 || verdictIndex > destReadIndex)) {
			violations.push({
				path,
				rule: 3,
				message: "mjs runner must adjudicate validation_success before any destination board/census",
			});
		}
	}
	return violations;
}

function firstDestinationCensusAfter(source, startIndex) {
	DESTINATION_CENSUS_RE.lastIndex = 0;
	let match;
	while ((match = DESTINATION_CENSUS_RE.exec(source)) !== null) {
		if (match.index > startIndex) return match.index;
	}
	return -1;
}

export function findGroundingViolations(files) {
	const violations = [];
	for (const { name, dialect, path, source } of files) {
		if (source.includes(ALLOW_MARKER)) continue;
		const code = stripComments(source, dialect);
		const hasPhysical = code.includes(PHYSICAL_COUNT);

		if (/fidelity/i.test(name) && !hasPhysical) {
			violations.push({
				path,
				rule: 1,
				message: "a *fidelity* test must do an independent physical count (get_item_count(...))",
			});
		}

		const usedReportField = SELF_REPORT_FIELDS.find((field) => code.includes(field));
		if (usedReportField && !hasPhysical) {
			violations.push({
				path,
				rule: 2,
				message: `reads validator self-report '${usedReportField}' without an independent physical count`,
			});
		}

		// Rules 1 and 2 above are dialect-INDEPENDENT. "Measure the invariant yourself rather than
		// believe the validator's self-report" is a property of the assertion, not of the language it
		// is written in, and `name` is the test DIRECTORY, so a fidelity-named mjs suite is detected
		// exactly the same way. They were ps1-only because this guard predated mjs runners, not by
		// design — measured when extending: zero of the six current mjs runners trips either rule, so
		// this is preventative rather than corrective, and the self-tests below are what give it teeth
		// in the absence of a live subject.
		//
		// Rule 3's markers below ARE PowerShell-specific (Read-DebugFile / Assert-TransferSucceeded);
		// the mjs equivalent of that ordering rule lives in findMjsGroundingViolations.
		if (dialect === "mjs") continue;

		const debugIndex = code.indexOf("debug_import_result");
		if (debugIndex === -1) continue;
		const censusIndex = firstDestinationCensusAfter(code, debugIndex);
		if (censusIndex === -1) continue;
		const readIndex = code.indexOf("Read-DebugFile", debugIndex);
		const assertIndex = code.indexOf("Assert-TransferSucceeded", debugIndex);
		if (readIndex === -1 || readIndex > censusIndex || assertIndex <= readIndex || assertIndex > censusIndex) {
			violations.push({
				path,
				rule: 3,
				message: "destination census must follow Read-DebugFile -> Assert-TransferSucceeded ordering",
			});
		}
	}
	return violations;
}

function main() {
	if (!existsSync(TESTS_DIR)) {
		// The ONLY sanctioned partial context is the plugin bind-mounted inside a cluster container at
		// /clusterio/external_plugins (no repo-root tests/ there — CLAUDE.md's in-container lint flow).
		// Positive path detection keeps the bypass reviewable: no ambient env-var can silence this
		// guard from a broken checkout elsewhere.
		if (/^([a-z]:)?\/clusterio\/external_plugins\//i.test(SCRIPT_DIR.replace(/\\/g, "/"))) {
			console.log(`lint:test-grounding - SKIPPED (plugin-only container mount; tests/integration not present at ${TESTS_DIR})`);
			return;
		}
		console.error(
			`lint:test-grounding - FAILED: ran 0 checks (tests/integration not found at ${TESTS_DIR}).\n` +
				"A missing scan surface is not a pass. Run from a full repository checkout.",
		);
		process.exit(1);
	}
	const files = findTestFiles();
	if (files.length === 0) {
		// The directory-present-but-empty case is the RECORDED incident shape: the ps1 runners were
		// deleted while tests/integration remained, and this guard printed "OK (0 tests checked)" —
		// a green guard scanning nothing, caught only by a human reading the count. Zero subjects
		// is not a pass any more than a missing scan surface is.
		console.error(
			`lint:test-grounding - FAILED: ${TESTS_DIR} exists but contains zero run-tests.{ps1,mjs} runners.\n` +
				"Ran 0 checks; refusing to report a pass on an empty scan surface.",
		);
		process.exit(1);
	}
	const violations = [...findGroundingViolations(files), ...findMjsGroundingViolations(files)];
	if (violations.length > 0) {
		console.error("lint:test-grounding - FAILED\n");
		for (const violation of violations) {
			console.error(`  ${violation.path}\n    Rule ${violation.rule}: ${violation.message}\n`);
		}
		console.error(
			"Fix the measured ordering/grounding, or escalate an owner-approved lint-test-grounding:allow annotation.",
		);
		process.exit(1);
	}
	console.log(`lint:test-grounding - OK (${files.length} integration test(s) checked, 3 grounding rules enforced)`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
