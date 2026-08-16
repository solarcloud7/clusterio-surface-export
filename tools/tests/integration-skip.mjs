#!/usr/bin/env node
// requires: nothing at import time; playwright is imported only when launchChromiumOrSkip() runs
// produces: the integration-suite SKIP protocol — a loud banner on the suite's stdout, a one-line
//           reason written to $SE_INTEGRATION_SKIP_FILE, and exit code 77 for run-integration-tests.mjs
// does not: decide to skip on any signal other than chromium reporting itself absent, convert a
//           browser failure into a skip (every other launch error rethrows), or make a skip count
//           as a pass — run-integration-tests.mjs fails any suite that exits 77 with no reason

import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const SKIP_EXIT_CODE = 77;
export const SKIP_REASON_ENV = "SE_INTEGRATION_SKIP_FILE";
export const INSTALL_ERROR_ENV = "SE_PLAYWRIGHT_INSTALL_ERROR";

const REASON_MAX_CHARS = 240;

const BROWSER_ABSENT_SIGNATURES = [
	"Executable doesn't exist",
	"Please run the following command to download",
];

function firstMeaningfulLine(text) {
	return String(text ?? "").split("\n").map(line => line.trim()).find(line => line.length > 0) ?? "";
}

export function skipSuite(suite, reason, detail = "") {
	const rule = "!".repeat(78);
	console.log(`\n${rule}`);
	console.log(`  SKIPPED — ${suite} did not run, and did NOT pass`);
	console.log(`  ${reason}`);
	if (detail) {
		for (const line of String(detail).split("\n")) { console.log(`  ${line}`); }
	}
	console.log(`${rule}\n`);

	const reasonFile = process.env[SKIP_REASON_ENV];
	if (reasonFile) {
		writeFileSync(reasonFile, firstMeaningfulLine(reason).slice(0, REASON_MAX_CHARS), "utf8");
	}
	process.exit(SKIP_EXIT_CODE);
}

function recordedInstallError() {
	const file = process.env[INSTALL_ERROR_ENV];
	if (!file || !existsSync(file)) { return null; }
	return readFileSync(file, "utf8").trim() || null;
}

export async function launchChromiumOrSkip(suite, options = {}) {
	const { chromium } = await import("playwright");
	try {
		return await chromium.launch(options);
	} catch (err) {
		const message = err && err.message ? err.message : String(err);
		if (!BROWSER_ABSENT_SIGNATURES.some(signature => message.includes(signature))) {
			throw err;
		}
		const installError = recordedInstallError();
		const detail = [
			"",
			"chromium reported itself absent at launch:",
			message,
			"",
			installError
				? `The browser install step recorded this failure:\n${installError}`
				: `No install failure was recorded (${INSTALL_ERROR_ENV} is unset or names no file).`,
			"",
			"Install it with: npx playwright install --with-deps chromium",
		].join("\n");
		const cause = firstMeaningfulLine(installError ?? message);
		return skipSuite(suite, `chromium is not installed — ${cause}`, detail);
	}
}
