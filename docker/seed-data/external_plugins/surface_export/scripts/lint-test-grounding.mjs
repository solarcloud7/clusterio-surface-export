#!/usr/bin/env node
/**
 * lint-test-grounding.mjs — mechanical guard for the integration-test grounding rule.
 *
 * The recurring failure mode (see the `data-integrity-test-grounding` memory and CLAUDE.md): a fidelity
 * test that asserts on a value DERIVED FROM THE CODE UNDER TEST proves nothing — it passes even when that
 * code is wrong. This session shipped `tests/integration/transfer-fidelity` asserting on `totalItemLoss`
 * (the validator's own report); it would have gone green on a broken meter. The catch came from an
 * INDEPENDENT physical count (`get_item_count` over both surfaces) and from adversarial review — never
 * from the validator's self-report. "Knowing the principle wasn't enough" — this script makes it mechanical.
 *
 * Rules (per tests/integration/<name>/run-tests.ps1, comments stripped):
 *   1. A FIDELITY test (directory name contains "fidelity") MUST perform an independent physical item
 *      count — `get_item_count(` — so the invariant is measured independently of the validator.
 *   2. ANY test that reads a validator SELF-REPORT fidelity field (`totalItemLoss`, `expectedItemCounts`,
 *      `actualItemCounts`) MUST also contain `get_item_count(` — i.e. cross-ground the report against
 *      physical truth; never let a fidelity claim rest solely on the value under test.
 *
 * Run:   node scripts/lint-test-grounding.mjs        (also: npm run lint:test-grounding)
 * Escape hatch: put a `lint-test-grounding:allow` comment (with a reason) anywhere in the test file to
 *               skip it — use sparingly (e.g. a test that legitimately does not touch item fidelity).
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// scripts/ -> surface_export -> external_plugins -> seed-data -> docker -> <repo root>
const REPO_ROOT = join(SCRIPT_DIR, "..", "..", "..", "..", "..");
const TESTS_DIR = join(REPO_ROOT, "tests", "integration");
const ALLOW_MARKER = "lint-test-grounding:allow";

const SELF_REPORT_FIELDS = ["totalItemLoss", "expectedItemCounts", "actualItemCounts"];
const PHYSICAL_COUNT = "get_item_count(";

// Strip PowerShell line comments (# ...) so a comment mentioning a field doesn't trip a rule. Keeps it
// simple/robust: we don't try to parse here-strings; the fields above don't appear in normal prose.
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
for (const { name, file } of findTestFiles()) {
  const raw = readFileSync(file, "utf8");
  if (raw.includes(ALLOW_MARKER)) continue; // explicitly opted out (with a reason)
  const code = stripComments(raw);
  const hasPhysical = code.includes(PHYSICAL_COUNT);
  const rel = relative(REPO_ROOT, file).replace(/\\/g, "/");

  // Rule 1: fidelity tests must measure physically.
  if (/fidelity/i.test(name) && !hasPhysical) {
    violations.push(
      `${rel}\n    Rule 1: a *fidelity* test must do an INDEPENDENT physical count (get_item_count(...)),` +
        ` not rely on the validator's own report. Measure the invariant independently of the code under test.`
    );
  }

  // Rule 2: reading a validator self-report fidelity field requires a physical cross-check.
  const usedReportField = SELF_REPORT_FIELDS.find((f) => code.includes(f));
  if (usedReportField && !hasPhysical) {
    violations.push(
      `${rel}\n    Rule 2: reads the validator self-report field '${usedReportField}' but has no independent` +
        ` physical count (get_item_count(...)). A fidelity claim must never rest solely on the value under test.`
    );
  }
}

if (violations.length > 0) {
  console.error("lint:test-grounding — FAILED\n");
  for (const v of violations) console.error("  " + v + "\n");
  console.error(
    "Fix: ground the assertion in an independent physical item count (get_item_count over source AND dest),\n" +
      "or add a `lint-test-grounding:allow` comment with a reason if the test legitimately doesn't touch item fidelity.\n" +
      "See the data-integrity-test-grounding memory / CLAUDE.md."
  );
  process.exit(1);
}

const total = findTestFiles().length;
if (!existsSync(TESTS_DIR)) {
  // Not a failure: this happens when the script runs from a context that doesn't include the repo-root
  // tests/ (e.g. the plugin-only container bind-mount). CI runs `npm run lint` on the full checkout, where
  // the tests ARE present and the rules are enforced. Make the no-op visible instead of a misleading "OK".
  console.log(`lint:test-grounding — SKIPPED (tests/integration not found at ${TESTS_DIR}; full checkout only)`);
  process.exit(0);
}
console.log(`lint:test-grounding — OK (${total} integration test(s) checked, 2 grounding rules enforced)`);
