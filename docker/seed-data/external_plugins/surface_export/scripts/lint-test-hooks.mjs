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
	"test_force_validation_failure", // pre-gate: forces validation FAIL → rollback → source preserved
	"test_force_entity_failure", // pre-gate: one entity fails to place → attributed loss → gate catches it
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
	const hasGuaranteedCleanup = /\bfinally\b|\btrap\b/.test(code);

	// Every hook this file ARMS (assigns a value that is not a disarm).
	const armed = new Set();
	const re = /test_force_(\w+)\s*=\s*([^\s,;})]+)/g;
	let m;
	while ((m = re.exec(code)) !== null) {
		if (!DISARM_VALUES.has(m[2])) {
			armed.add("test_force_" + m[1]);
		}
	}

	const risky = [...armed].filter((h) => !FAIL_SAFE_HOOKS.has(h));
	if (risky.length > 0 && !hasGuaranteedCleanup) {
		const rel = relative(REPO_ROOT, file).replace(/\\/g, "/");
		violations.push(
			`${rel}\n    arms mutating hook(s) [${risky.join(", ")}] not verified pre-gate, but has no ` +
				`finally/trap block to GUARANTEE disarm — a leaked flag detonates on the next transfer's error/flaky path.`,
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
	// Not a failure: the plugin-only container bind-mount has no repo-root tests/. CI runs `npm run lint` on
	// the full checkout, where the tests ARE present and the rule is enforced. Make the no-op visible.
	console.log(`lint:test-hooks — SKIPPED (tests/integration not found at ${TESTS_DIR}; full checkout only)`);
	process.exit(0);
}
console.log(
	`lint:test-hooks — OK (${findTestFiles().length} integration test(s) checked; ` +
		`${FAIL_SAFE_HOOKS.size} hook(s) whitelisted pre-gate)`,
);
