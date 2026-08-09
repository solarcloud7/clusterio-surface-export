#!/usr/bin/env node

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = join(SCRIPT_DIR, "..", "module");
const REPO_ROOT = join(SCRIPT_DIR, "..", "..", "..", "..", "..");

const LOG_RE = /\blog\s*\(|\bpcall_warn\b|game\.print\s*\(|rcon\.print\s*\(|\berror\s*\(/;
const ALLOW_RE = /intentional probe|failure expected|pcall:allow/i;
const LOG_WINDOW = 50;
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
    const code = lines[i].replace(/--.*$/, "");
    if (!/\bpcall\s*\(/.test(code)) continue;
    pcallTotal++;
    if (/pcall_warn/.test(lines[i])) continue;

    // Annotated as an intentional probe within +/-2 lines?
    let allowed = false;
    for (let j = Math.max(0, i - ALLOW_WINDOW); j <= Math.min(lines.length - 1, i + ALLOW_WINDOW); j++) {
      if (ALLOW_RE.test(lines[j])) { allowed = true; break; }
    }
    if (allowed) continue;

    if (/\breturn\s+pcall\s*\(/.test(code)) continue;

    const assign = code.match(/(?:local\s+)?([A-Za-z_][\w,\s]*?)\s*=\s*pcall\s*\(/);
    if (!assign) {
      violations.push(`${rel}:${i + 1}  fire-and-forget pcall (error dropped) — use Util.pcall_warn(ctx, fn) or capture+log`);
      continue;
    }
    const vars = assign[1].split(",").map((s) => s.trim()).filter(Boolean);
    const okVar = vars[0] && vars[0] !== "_" ? vars[0] : null;
    const errVar = vars[1] && vars[1] !== "_" ? vars[1] : null;

    const maskRe = okVar && errVar
      ? new RegExp(`\\b${okVar}\\s+and\\s+${errVar}\\b[^\\n]*?\\bor\\b`)
      : null;

    let handled = false;
    let maskedSelection = false;
    for (let j = i; j <= Math.min(lines.length - 1, i + LOG_WINDOW); j++) {
      const cj = lines[j].replace(/--.*$/, "");
      if (j > i && /\bpcall\s*\(/.test(cj)) break;
      if (LOG_RE.test(lines[j])) { handled = true; break; }
      if (errVar && new RegExp(`\\b${errVar}\\b`).test(cj) && /\breturn\b|\berrors\b|\bwarnings\b|insert/.test(cj)) {
        if (maskRe && maskRe.test(cj)) { maskedSelection = true; continue; }
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
