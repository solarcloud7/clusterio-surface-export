#!/usr/bin/env node

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
const IMPORT_RESULT_FETCH_RE = /debug_import_result|\b\w*[Ii]mportResults?\b/;
const VERDICT_FIELD = "validation_success";
const DESTINATION_BOARD_MARKERS = ["runBoard(2", "runBoard(destHost", "Count-", "census"];

function stripComments(source, dialect = "ps1") {
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

function firstDestinationBoardAfter(code, startIndex) {
	let earliest = -1;
	for (const marker of DESTINATION_BOARD_MARKERS) {
		const index = code.indexOf(marker, startIndex);
		if (index !== -1 && (earliest === -1 || index < earliest)) earliest = index;
	}
	return earliest;
}

export function findMjsGroundingViolations(files) {
	const violations = [];
	for (const { dialect, path, source } of files) {
		if (dialect !== "mjs" || source.includes(ALLOW_MARKER)) continue;
		const code = stripComments(source, "mjs");
		const fetched = code.match(IMPORT_RESULT_FETCH_RE);
		if (fetched === null) continue;
		const fetchIndex = fetched.index;
		const verdictIndex = code.indexOf(VERDICT_FIELD, fetchIndex);
		if (verdictIndex === -1) {
			violations.push({
				path,
				rule: 3,
				message: `mjs runner fetches an import result but never adjudicates ${VERDICT_FIELD}`,
			});
			continue;
		}
		const destReadIndex = firstDestinationBoardAfter(code, fetchIndex);
		if (destReadIndex !== -1 && verdictIndex > destReadIndex) {
			violations.push({
				path,
				rule: 3,
				message: `mjs runner must adjudicate ${VERDICT_FIELD} before any destination board/census`,
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
