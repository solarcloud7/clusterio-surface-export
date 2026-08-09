#!/usr/bin/env node

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..", "..", "..", "..", "..");
const TESTS_DIR = join(REPO_ROOT, "tests", "integration");
const ALLOW_MARKER = "lint-test-hooks:allow";

import { FAIL_SAFE_HOOKS } from "./fail-safe-hooks.mjs";

const DISARM_VALUES = new Set(["0", "false", "$false", "nil", "null", "$null"]);

function stripComments(src) {
	return src
		.split(/\r?\n/)
		.map((line) => {
			const i = line.indexOf("#");
			return i === -1 ? line : line.slice(0, i);
		})
		.join("\n");
}

function stripStrings(code) {
	return code.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
}

function extractGuaranteedCleanup(code) {
	let out = "";
	const kw = /\b(?:finally|trap)\b/g;
	let m;
	while ((m = kw.exec(code)) !== null) {
		const open = code.indexOf("{", m.index);
		if (open === -1) continue;
		let depth = 0, j = open;
		for (; j < code.length; j++) {
			if (code[j] === "{") depth++;
			else if (code[j] === "}" && --depth === 0) break;
		}
		out += code.slice(open + 1, j) + "\n";
		kw.lastIndex = j;
	}
	return out;
}

function findTestFiles() {
	if (!existsSync(TESTS_DIR)) return [];
	const out = [];
	for (const name of readdirSync(TESTS_DIR)) {
		const dir = join(TESTS_DIR, name);
		if (!statSync(dir).isDirectory()) continue;
		for (const runner of ["run-tests.ps1", "run-tests.mjs"]) {
			const f = join(dir, runner);
			if (existsSync(f)) out.push({ name, file: f });
		}
	}
	return out;
}

const violations = [];
for (const { file } of findTestFiles()) {
	const raw = readFileSync(file, "utf8");
	if (raw.includes(ALLOW_MARKER)) continue;
	const code = stripComments(raw);
	const cleanup = extractGuaranteedCleanup(stripStrings(code));

	const armed = new Set();
	const re = /(?:test_force_(\w+)|(preserve_failed_destination))\s*=\s*([^\s,;})]+)/g;
	let m;
	while ((m = re.exec(code)) !== null) {
		if (!DISARM_VALUES.has(m[3])) {
			armed.add(m[2] || "test_force_" + m[1]);
		}
	}

	const risky = [...armed].filter((h) => !FAIL_SAFE_HOOKS.has(h));
	const notCleaned = risky.filter((h) => !new RegExp(h + "\\s*=\\s*(?:0|false|\\$false|nil|null|\\$null)\\b").test(cleanup));
	if (notCleaned.length > 0) {
		const rel = relative(REPO_ROOT, file).replace(/\\/g, "/");
		violations.push(
			`${rel}\n    arms mutating hook(s) [${notCleaned.join(", ")}] not verified pre-gate, whose DISARM is NOT ` +
				`inside a finally/trap block — a leaked flag detonates on the next transfer's error/flaky path.`,
		);
	}
}

if (violations.length > 0) {
	console.error("lint:test-hooks — FAILED\n");
	for (const v of violations) console.error("  " + v + "\n");
	console.error(
		"Fix: disarm the hook in a `finally { ... }` (PowerShell runs finally even on `exit`) or a `trap`, so an\n" +
			"early `exit 1`/throw between arm and disarm can't leave it armed for the next transfer. If the hook is\n" +
			"verified PRE-gate (a leak fails the next transfer's gate + preserves its source), add it to\n" +
			"FAIL_SAFE_HOOKS in scripts/lint-test-hooks.mjs — a reviewable act; run /code-review on test-hook changes.\n" +
			"See the test-hook-mutating-must-be-fail-safe memory / CLAUDE.md.\n",
	);
	process.exit(1);
}

if (!existsSync(TESTS_DIR)) {
	if (/^([a-z]:)?\/clusterio\/external_plugins\//i.test(SCRIPT_DIR.replace(/\\/g, "/"))) {
		console.log(`lint:test-hooks — SKIPPED (plugin-only container mount; tests/integration not present at ${TESTS_DIR})`);
		process.exit(0);
	}
	console.error(
		`lint:test-hooks — FAILED: ran 0 checks (tests/integration not found at ${TESTS_DIR}).\n` +
			"A missing scan surface is not a pass. Run from a full repository checkout.",
	);
	process.exit(1);
}
const checkedCount = findTestFiles().length;
if (checkedCount === 0) {
	console.error(
		`lint:test-hooks — FAILED: ${TESTS_DIR} exists but contains zero run-tests.{ps1,mjs} runners.\n` +
			"Ran 0 checks; refusing to report a pass on an empty scan surface.",
	);
	process.exit(1);
}
console.log(
	`lint:test-hooks — OK (${checkedCount} integration test(s) checked; ` +
		`${FAIL_SAFE_HOOKS.size} hook(s) whitelisted pre-gate)`,
);
