#!/usr/bin/env node
/**
 * lint-pcall-logging.mjs — every `pcall` in module/ must SURFACE its error (log it), never swallow it.
 *
 * Why (see the never-swallow-pcall-errors memory + CLAUDE.md): a pcall around a belt insert swallowed the
 * error "items: table expected, got number" — the smoking gun for a 2.0.76 API signature mismatch — which
 * hid the bug across two failed fix attempts. A pcall that catches an error but never logs it turns a loud,
 * diagnosable failure into a silent, mysterious one. The rule: keep the plugin from crashing, but make every
 * failure visible.
 *
 * A `pcall(` is OK if ANY of:
 *   - it is a `pcall_warn(...)` call (the canonical logging wrapper, utils/game-utils.lua), OR
 *   - it is CAPTURED (`= pcall(...)` / `return pcall(...)`) AND a log()/print()/pcall_warn appears within the
 *     next LOG_WINDOW lines (the failure path is surfaced), OR
 *   - it is annotated within +/-2 lines with `intentional probe` / `failure expected` / `pcall:allow`
 *     (an intentional control-flow existence/readability probe that is expected to fail per-entity).
 * Otherwise it is FLAGGED. A FIRE-AND-FORGET `pcall(function() ... end)` (result dropped) can never surface
 * its error, so it is always flagged unless annotated.
 *
 * Run:   node scripts/lint-pcall-logging.mjs        (also: npm run lint:pcall-logging)
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = join(SCRIPT_DIR, "..", "module");
// scripts/ -> surface_export -> external_plugins -> seed-data -> docker -> <repo root>
const REPO_ROOT = join(SCRIPT_DIR, "..", "..", "..", "..", "..");

const LOG_RE = /\blog\s*\(|\bpcall_warn\b|game\.print\s*\(|rcon\.print\s*\(|\berror\s*\(/;
const ALLOW_RE = /intentional probe|failure expected|pcall:allow/i;
const LOG_WINDOW = 50; // lines after a captured pcall to find the failure handling (pcalls can wrap big blocks)
const ALLOW_WINDOW = 2;

function luaFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...luaFiles(p));
    else if (name.endsWith(".lua")) out.push(p);
  }
  return out;
}

const violations = [];
let pcallTotal = 0;
for (const file of luaFiles(MODULE_DIR)) {
  const raw = readFileSync(file, "utf8");
  const lines = raw.split(/\r?\n/);
  const rel = relative(REPO_ROOT, file).replace(/\\/g, "/");
  for (let i = 0; i < lines.length; i++) {
    const code = lines[i].replace(/--.*$/, ""); // strip line comment
    if (!/\bpcall\s*\(/.test(code)) continue;
    pcallTotal++;
    if (/pcall_warn/.test(lines[i])) continue; // the logging wrapper (or its definition)

    // Annotated as an intentional probe within +/-2 lines?
    let allowed = false;
    for (let j = Math.max(0, i - ALLOW_WINDOW); j <= Math.min(lines.length - 1, i + ALLOW_WINDOW); j++) {
      if (ALLOW_RE.test(lines[j])) { allowed = true; break; }
    }
    if (allowed) continue;

    // `return pcall(...)` hands ok+err to the caller — surfaced there.
    if (/\breturn\s+pcall\s*\(/.test(code)) continue;

    const assign = code.match(/(?:local\s+)?([A-Za-z_][\w,\s]*?)\s*=\s*pcall\s*\(/);
    if (!assign) {
      // Fire-and-forget: the error is dropped and can never be surfaced.
      violations.push(`${rel}:${i + 1}  fire-and-forget pcall (error dropped) — use Util.pcall_warn(ctx, fn) or capture+log`);
      continue;
    }
    const vars = assign[1].split(",").map((s) => s.trim()).filter(Boolean);
    const okVar = vars[0] && vars[0] !== "_" ? vars[0] : null; // 1st value = pcall ok flag
    const errVar = vars[1] && vars[1] !== "_" ? vars[1] : null; // 2nd value = error on failure

    // Value-selection swallow (the known evasion, see pcall-catch-swallow-audit): `(ok and v) or default`
    // REFERENCES the error-carrying variable but silently converts the failure into a default — the error
    // never reaches a log or the caller distinctly. Such a reference must NOT count as propagation.
    const maskRe = okVar && errVar
      ? new RegExp(`\\b${okVar}\\s+and\\s+${errVar}\\b[^\\n]*?\\bor\\b`)
      : null;

    let handled = false;
    let maskedSelection = false;
    for (let j = i; j <= Math.min(lines.length - 1, i + LOG_WINDOW); j++) {
      const cj = lines[j].replace(/--.*$/, "");
      if (j > i && /\bpcall\s*\(/.test(cj)) break; // reached the next pcall — a new concern
      if (LOG_RE.test(lines[j])) { handled = true; break; } // logs OR re-raises via error(...)
      // error propagated to the caller (return ..., err / collected into an errors|warnings table):
      if (errVar && new RegExp(`\\b${errVar}\\b`).test(cj) && /\breturn\b|\berrors\b|\bwarnings\b|insert/.test(cj)) {
        if (maskRe && maskRe.test(cj)) { maskedSelection = true; continue; } // `(ok and v) or …` = swallow, keep scanning
        handled = true;
        break;
      }
    }
    if (!handled) {
      violations.push(maskedSelection
        ? `${rel}:${i + 1}  pcall error consumed by \`(${okVar} and ${errVar}) or …\` value-selection — the failure is silently converted to a default; log it or propagate it distinctly`
        : `${rel}:${i + 1}  captured pcall whose error is neither logged nor propagated within ${LOG_WINDOW} lines`);
    }
  }
}

if (violations.length) {
  console.error("lint:pcall-logging — FAILED\n");
  for (const v of violations) console.error("  " + v);
  console.error(
    `\n${violations.length} pcall(s) may swallow errors silently. Fix each by one of:\n` +
      "  - Util.pcall_warn(\"[file] what\", function() ... end)   (fire-and-forget; logs context+err)\n" +
      "  - keep `local ok, v = pcall(...)` and add `if not ok then log(...) end`\n" +
      "  - annotate `-- intentional probe; failure expected, no log` if it is a control-flow existence probe.\n" +
      "See the never-swallow-pcall-errors memory / CLAUDE.md."
  );
  process.exit(1);
}
console.log(`lint:pcall-logging — OK (${pcallTotal} pcall(s) in module/ all surface their errors or are annotated)`);
