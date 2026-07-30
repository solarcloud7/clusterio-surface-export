#!/usr/bin/env node
/**
 * lint-ps-silent.mjs — PowerShell silent-failure guard for the repo's tooling.
 *
 * The pcall-logging guard covers Lua and the catch-swallow guard covers TypeScript; PowerShell was
 * the ungated dialect, and it is the one that has bitten hardest: patch-and-reset once ended every
 * clusterioctl call in `2>$null` with no exit check, so 11 broken calls produced zero output and a
 * false success (the --config= incident, see that script's header). A fail-loud campaign converted
 * the tree; this guard keeps it converted.
 *
 * Rule: a PowerShell-stream suppression —
 *     `2>$null`, `-ErrorAction SilentlyContinue`, `-ErrorAction Ignore`, or an EMPTY `catch {}`
 * — is a violation unless it is one of the two lawful shapes already used across the tree:
 *   CHECKED   the exit code is consulted within the next 3 lines ($LASTEXITCODE or $?), so a
 *             failure changes behavior instead of vanishing (probe pattern). Not available to
 *             empty catch{} — an empty catch checks nothing by definition.
 *   ANNOTATED a comment containing "deliberately quiet" or "intentional probe" (any case) on the
 *             same line or within the 3 lines above, stating the REAL reason the void is safe
 *             (bounded poll, idempotent cleanup, existence probe...). The reason is the point:
 *             it forces the author to argue the case where the reviewer can see it.
 *
 * NOT flagged: `2>/dev/null` inside sh -c '...' strings — that is container-side shell suppression
 * (benign glob-miss handling), a different stream on a different machine.
 *
 * Scope: tools/ ** /*.ps1 and tests/ ** /*.{ps1,psm1} at the repo root (absent in the sanctioned
 * plugin-only container mount — same positive-path bypass as lint-test-grounding).
 *
 * Run:   node scripts/lint-ps-silent.mjs        (also: npm run lint:ps-silent)
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// scripts/ -> plugin -> external_plugins -> seed-data -> docker -> repo root
const REPO_ROOT = join(SCRIPT_DIR, "..", "..", "..", "..", "..");
const SCAN_DIRS = [join(REPO_ROOT, "tools"), join(REPO_ROOT, "tests")];

const ANNOTATION = /deliberately quiet|intentional probe/i;
// checkMark: which exit-status token counts as CHECKED for this rule. Cmdlet-level suppression
// (-ErrorAction) never sets $LASTEXITCODE — only native exes do — so only $? is a real check there
// (review-caught: accepting $LASTEXITCODE made that rule's CHECKED shape semantically vacuous).
const SUPPRESSIONS = [
	{ id: "stderr-to-null", regex: /[2*]>\s*\$null/i, checkMark: /\$LASTEXITCODE|\$\?/ },
	{ id: "merged-discard", regex: /2>&1\s*\|\s*Out-Null/i, checkMark: /\$LASTEXITCODE|\$\?/ },
	{ id: "silently-continue", regex: /-(?:EA|ErrorAction)[\s:]+['"]?(?:SilentlyContinue|Ignore)\b/i, checkMark: /\$\?/ },
	{ id: "preference-silence", regex: /\$ErrorActionPreference\s*=\s*['"](?:SilentlyContinue|Ignore)['"]/i, checkMark: null },
];
// The empty-catch rule runs over the whole comment-stripped text, not per line — `catch {` with the
// brace closed on a later line (or a comment-only body) is the same swallow (review-caught miss).
const EMPTY_CATCH = /\bcatch\s*\{\s*\}/g;

function collectPsFiles(dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) out.push(...collectPsFiles(full));
		else if (/\.psm?1$/i.test(name)) out.push(full);
	}
	return out;
}

/** Strip a PowerShell line comment (# ...) so incident-history PROSE that quotes an anti-pattern
 *  (this tree has plenty) never trips the rule — only executable code does. Heuristic indexOf,
 *  same as the test-hooks guard; a '#' inside a string is rare in these files and only ever
 *  UNDER-matches (drops code after it), never invents a violation. */
function stripComment(line) {
	const idx = line.indexOf("#");
	return idx === -1 ? line : line.slice(0, idx);
}

function lintFile(file) {
	const relPath = relative(REPO_ROOT, file).replace(/\\/g, "/");
	const lines = readFileSync(file, "utf8").split(/\r?\n/);
	const stripped = lines.map(stripComment);
	const violations = [];

	const annotated = (i) => ANNOTATION.test(lines.slice(Math.max(0, i - 3), i + 1).join("\n"));
	// CHECKED reads the comment-STRIPPED window: a prose mention of $LASTEXITCODE must not
	// satisfy the check (review-caught masking path).
	const checked = (i, mark) => mark !== null && mark.test(stripped.slice(i, Math.min(stripped.length, i + 4)).join("\n"));

	stripped.forEach((code, i) => {
		for (const rule of SUPPRESSIONS) {
			if (!rule.regex.test(code)) continue;
			if (annotated(i) || checked(i, rule.checkMark)) continue;
			violations.push({ file: relPath, line: i + 1, id: rule.id, text: lines[i].trim() });
		}
	});

	// Empty catch over the whole stripped text (multi-line and comment-only bodies included).
	// An empty catch checks nothing by definition — annotation is its only lawful shape.
	const text = stripped.join("\n");
	for (const m of text.matchAll(EMPTY_CATCH)) {
		const line = text.slice(0, m.index).split("\n").length - 1;
		if (annotated(line)) continue;
		violations.push({ file: relPath, line: line + 1, id: "empty-catch", text: lines[line].trim() });
	}
	return violations;
}

function main() {
	const missing = SCAN_DIRS.filter((d) => !existsSync(d));
	if (missing.length > 0) {
		if (/^([a-z]:)?\/clusterio\/external_plugins\//i.test(SCRIPT_DIR.replace(/\\/g, "/"))) {
			console.log("lint:ps-silent — SKIPPED (plugin-only container mount; repo tools/ and tests/ not present)");
			return;
		}
		// ANY missing scan dir fails — silently scanning half the surface while printing OK was a
		// review-caught defect (the sibling lua-syntax guard already took this posture).
		console.error(`lint:ps-silent — FAILED: missing scan director${missing.length > 1 ? "ies" : "y"}: ${missing.join(", ")}. A missing scan surface is not a pass.`);
		process.exit(1);
	}
	const files = SCAN_DIRS.flatMap(collectPsFiles);
	if (files.length === 0) {
		console.error("lint:ps-silent — FAILED: scan directories exist but contain zero .ps1/.psm1 files. Ran 0 checks; refusing to report a pass.");
		process.exit(1);
	}
	const violations = files.flatMap(lintFile);
	if (violations.length === 0) {
		console.log(`lint:ps-silent — OK (${files.length} PowerShell file(s); every suppression is checked or annotated)`);
		process.exit(0);
	}
	console.error(`lint:ps-silent — ${violations.length} violation(s):\n`);
	for (const v of violations) {
		console.error(`  ${v.file}:${v.line}  [${v.id}]`);
		console.error(`    ${v.text}\n`);
	}
	console.error(
		"A suppressed failure reads as success (the 11-broken-calls incident). Either consult the exit code within "
			+ "3 lines ($LASTEXITCODE/$?), or add a comment with the words \"deliberately quiet\" + the REAL reason "
			+ "(bounded poll, idempotent cleanup, existence probe). Empty catch{} must surface something or be annotated.",
	);
	process.exit(1);
}

main();
