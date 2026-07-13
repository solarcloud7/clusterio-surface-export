#!/usr/bin/env node
/**
 * lint-test-hooks.mjs — guard: a debug-gated test hook that MUTATES game state must be fail-safe on LEAK.
 *
 * See the `test-hook-mutating-must-be-fail-safe` memory + CLAUDE.md. `/code-review` (not the author) caught
 * `test_force_entity_loss`: a POST-gate, destructive, persisted hook whose arming integration test disarmed
 * only on its success path (5 early `exit 1` paths skipped the cleanup). On a leaked flag (`debug_mode`
 * defaults true on the always-up shared cluster, Pitfall #13) the NEXT unrelated transfer silently destroyed
 * dest entities AFTER its gate passed → still SUCCESS → source deleted = real, unattributed data loss, firing
 * only on the flaky/error path (hardest to notice).
 *
 * Rule: an integration test that ARMS a `test_force_*` hook (assigns it a non-disarm value) must GUARANTEE
 * disarm on every exit path — i.e. the file must contain a `finally` or `trap` block, where the disarm goes
 * (PowerShell runs `finally` even on `exit`). EXEMPT: hooks VERIFIED pre-gate / self-protecting — a leak makes
 * the next transfer FAIL its gate and PRESERVE its source — listed in FAIL_SAFE_HOOKS below. Adding a hook
 * there is a deliberate, reviewable act (it MUST be pre-gate; run /code-review on test-hook changes). A
 * post-gate or destructive hook must NEVER be added to that list.
 *
 * Run:   node scripts/lint-test-hooks.mjs        (also: npm run lint:test-hooks)
 * Escape hatch: a `lint-test-hooks:allow` comment (with a reason) anywhere in the test file skips it.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// scripts/ -> surface_export -> external_plugins -> seed-data -> docker -> <repo root>
const REPO_ROOT = join(SCRIPT_DIR, "..", "..", "..", "..", "..");
const TESTS_DIR = join(REPO_ROOT, "tests", "integration");
const ALLOW_MARKER = "lint-test-hooks:allow";

// Hooks VERIFIED pre-gate / self-protecting: on a leaked flag the next transfer FAILS its item/validation
// gate and PRESERVES its source, so a skipped disarm is fail-safe. Each entry MUST be pre-gate — a
// post-gate/destructive hook here would defeat the guard, so adding one is a reviewable act.
const FAIL_SAFE_HOOKS = new Set([
	"test_force_item_loss", // pre-gate: inflates the loss the strict gate counts → gate FAILS → source preserved
	"test_force_fluid_loss", // pre-gate: inflates expected fluids before the single exact gate → gate FAILS → dest discarded/source preserved
	"test_force_validation_failure", // pre-gate: forces validation FAIL → rollback → source preserved
	"test_force_entity_failure", // pre-gate: marker forces verdict FAIL after attribution → source preserved
]);

// A value that DISARMS a hook rather than arming it — these assignments are safe and don't require cleanup.
const DISARM_VALUES = new Set(["0", "false", "$false", "nil", "null", "$null"]);

// Strip PowerShell line comments (# ...) so a commented-out arm or a prose mention doesn't trip the rule.
function stripComments(src) {
	return src
		.split(/\r?\n/)
		.map((line) => {
			const i = line.indexOf("#");
			return i === -1 ? line : line.slice(0, i);
		})
		.join("\n");
}

// Extract the bodies of all `finally { ... }` and `trap { ... }` blocks (brace-matched, nesting-aware) so we can
// check that a hook's DISARM actually lives inside a guaranteed-cleanup block — not merely that SOME unrelated
// finally/trap exists elsewhere in the file. (The weakness a review caught: a temp-file cleanup `finally`
// satisfied the old file-level presence check while the hook's disarm sat only on the success path.)
// Blank the CONTENTS of quoted strings so braces INSIDE a string can't skew the brace-matcher (an unbalanced
// brace in `finally { $x = "{" }` would otherwise let the block run to EOF and mask a later violation). Simple
// single/double-quoted strings only; here-strings are rare in test files — a documented residual gap.
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
		kw.lastIndex = j; // resume scanning after this block
	}
	return out;
}

function findTestFiles() {
	if (!existsSync(TESTS_DIR)) return [];
	const out = [];
	for (const name of readdirSync(TESTS_DIR)) {
		const dir = join(TESTS_DIR, name);
		if (!statSync(dir).isDirectory()) continue;
		const f = join(dir, "run-tests.ps1");
		if (existsSync(f)) out.push({ name, file: f });
	}
	return out;
}

const violations = [];
for (const { file } of findTestFiles()) {
	const raw = readFileSync(file, "utf8");
	if (raw.includes(ALLOW_MARKER)) continue; // explicitly opted out (with a reason)
	const code = stripComments(raw);
	const cleanup = extractGuaranteedCleanup(stripStrings(code));

	// Every hook this file ARMS (assigns a value that is not a disarm).
	const armed = new Set();
	const re = /(?:test_force_(\w+)|(preserve_failed_destination))\s*=\s*([^\s,;})]+)/g;
	let m;
	while ((m = re.exec(code)) !== null) {
		if (!DISARM_VALUES.has(m[3])) {
			armed.add(m[2] || "test_force_" + m[1]);
		}
	}

	// A risky (armed, not-pre-gate) hook is fail-safe ONLY if its DISARM sits INSIDE a finally/trap block — not
	// merely if some unrelated finally exists somewhere in the file. Check the disarm is in the cleanup region.
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
	// A guard that ran 0 checks must not look like a pass: "no code failed" reads as green in a
	// hurry. The plugin-only container bind-mount (no repo-root tests/) is the ONLY sanctioned
	// partial context, and it must say so explicitly via LINT_ALLOW_PARTIAL=1.
	if (process.env.LINT_ALLOW_PARTIAL === "1") {
		console.log(`lint:test-hooks — SKIPPED (tests/integration not found at ${TESTS_DIR}; LINT_ALLOW_PARTIAL=1)`);
		process.exit(0);
	}
	console.error(
		`lint:test-hooks — FAILED: ran 0 checks (tests/integration not found at ${TESTS_DIR}).\n` +
			"A missing scan surface is not a pass. Run from a full checkout, or set LINT_ALLOW_PARTIAL=1 " +
			"only in a deliberately plugin-only context (e.g. the plugin-only container mount).",
	);
	process.exit(1);
}
console.log(
	`lint:test-hooks — OK (${findTestFiles().length} integration test(s) checked; ` +
		`${FAIL_SAFE_HOOKS.size} hook(s) whitelisted pre-gate)`,
);
