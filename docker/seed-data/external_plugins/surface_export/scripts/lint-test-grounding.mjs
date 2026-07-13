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
 * Rules per tests/integration/<name>/run-tests.ps1, with comments stripped:
 *   1. A fidelity test performs an independent physical item count.
 *   2. Validator fidelity self-reports are cross-grounded physically.
 *   3. A success-path destination census follows Read-DebugFile -> Assert-TransferSucceeded.
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

function stripComments(source) {
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
		const file = join(directory, "run-tests.ps1");
		if (!existsSync(file)) continue;
		files.push({
			name,
			path: relative(REPO_ROOT, file).replace(/\\/g, "/"),
			source: readFileSync(file, "utf8"),
		});
	}
	return files;
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
	for (const { name, path, source } of files) {
		if (source.includes(ALLOW_MARKER)) continue;
		const code = stripComments(source);
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
	const violations = findGroundingViolations(files);
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
