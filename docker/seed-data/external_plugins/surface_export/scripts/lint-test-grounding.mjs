#!/usr/bin/env node

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { basename, dirname, join, relative } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..", "..", "..", "..", "..");
const TESTS_DIR = join(REPO_ROOT, "tests", "integration");
const INSTRUMENTS_DIR = join(REPO_ROOT, "tests", "instruments");
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
				unit: `tests/integration/${name}`,
				dialect: runner.endsWith(".mjs") ? "mjs" : "ps1",
				path: relative(REPO_ROOT, file).replace(/\\/g, "/"),
				source: readFileSync(file, "utf8"),
			});
		}
	}
	return files;
}

export function isScannedInstrumentFile(fileName) {
	return /\.(mjs|ps1)$/.test(fileName) && !fileName.endsWith(".test.mjs");
}

function walkFiles(directory, out = []) {
	for (const name of readdirSync(directory)) {
		const file = join(directory, name);
		if (statSync(file).isDirectory()) walkFiles(file, out);
		else out.push(file);
	}
	return out;
}

export function instrumentUnitName(relativePath) {
	return relativePath.slice("tests/instruments/".length).split("/")[0];
}

function findInstrumentFiles() {
	if (!existsSync(INSTRUMENTS_DIR)) return [];
	const files = [];
	for (const file of walkFiles(INSTRUMENTS_DIR)) {
		if (!isScannedInstrumentFile(basename(file))) continue;
		const path = relative(REPO_ROOT, file).replace(/\\/g, "/");
		const name = instrumentUnitName(path);
		files.push({
			name,
			unit: `tests/instruments/${name}`,
			dialect: file.endsWith(".mjs") ? "mjs" : "ps1",
			path,
			source: readFileSync(file, "utf8"),
		});
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

function unitPhysicalCounts(files) {
	const counted = new Map();
	for (const { unit, path, dialect, source } of files) {
		const key = unit ?? path;
		const physical = stripComments(source, dialect).includes(PHYSICAL_COUNT);
		counted.set(key, (counted.get(key) ?? false) || physical);
	}
	return counted;
}

export function findGroundingViolations(files) {
	const violations = [];
	const unitHasPhysical = unitPhysicalCounts(files);
	const reportedUnits = new Set();
	for (const { name, dialect, path, unit, source } of files) {
		if (source.includes(ALLOW_MARKER)) continue;
		const code = stripComments(source, dialect);
		const hasPhysical = code.includes(PHYSICAL_COUNT);
		const unitKey = unit ?? path;

		if (/fidelity/i.test(name) && !unitHasPhysical.get(unitKey) && !reportedUnits.has(unitKey)) {
			reportedUnits.add(unitKey);
			violations.push({
				path: unitKey,
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

const SCAN_ROOTS = [
	{ dir: TESTS_DIR, label: "tests/integration", surface: "run-tests.{ps1,mjs} runners", collect: findTestFiles },
	{ dir: INSTRUMENTS_DIR, label: "tests/instruments", surface: "*.{mjs,ps1} files outside *.test.mjs", collect: findInstrumentFiles },
];

function main() {
	const missing = SCAN_ROOTS.filter((root) => !existsSync(root.dir));
	if (missing.length > 0) {
		const names = missing.map((root) => root.label).join(", ");
		if (/^([a-z]:)?\/clusterio\/external_plugins\//i.test(SCRIPT_DIR.replace(/\\/g, "/"))) {
			console.log(`lint:test-grounding - SKIPPED (plugin-only container mount; ${names} not present under ${REPO_ROOT})`);
			return;
		}
		console.error(
			`lint:test-grounding - FAILED: ran 0 checks (${names} not found under ${REPO_ROOT}).\n` +
				"A missing scan surface is not a pass. Run from a full repository checkout.",
		);
		process.exit(1);
	}
	const collected = SCAN_ROOTS.map((root) => ({ root, files: root.collect() }));
	const empty = collected.filter((entry) => entry.files.length === 0);
	if (empty.length > 0) {
		console.error(
			`lint:test-grounding - FAILED: ${empty.map((entry) => entry.root.label).join(", ")} exists but contains zero ` +
				`${empty.map((entry) => entry.root.surface).join(" / ")}.\n` +
				"Ran 0 checks on that root; refusing to report a pass on an empty scan surface.",
		);
		process.exit(1);
	}
	const files = collected.flatMap((entry) => entry.files);
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
	const counts = collected.map((entry) => `${entry.files.length} ${entry.root.label}`).join(" + ");
	console.log(`lint:test-grounding - OK (${counts} file(s) checked, 3 grounding rules enforced)`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
