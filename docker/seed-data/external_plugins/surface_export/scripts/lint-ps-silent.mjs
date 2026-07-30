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
const SUPPRESSIONS = [
	{ id: "stderr-to-null", regex: /2>\s*\$null/i, checkable: true },
	{ id: "silently-continue", regex: /-ErrorAction\s+(?:SilentlyContinue|Ignore)\b/i, checkable: true },
	{ id: "empty-catch", regex: /\bcatch\s*\{\s*\}/, checkable: false },
];

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
	const violations = [];
	lines.forEach((line, i) => {
		const code = stripComment(line);
		for (const rule of SUPPRESSIONS) {
			if (!rule.regex.test(code)) continue;
			// ANNOTATED: same line or up to 3 lines above carries the stated reason.
			const context = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
			if (ANNOTATION.test(context)) continue;
			// CHECKED: the exit code is consulted within the next 3 lines (probe pattern).
			if (rule.checkable) {
				const below = lines.slice(i, Math.min(lines.length, i + 4)).join("\n");
				if (/\$LASTEXITCODE|\$\?/.test(below)) continue;
			}
			violations.push({ file: relPath, line: i + 1, id: rule.id, text: line.trim() });
		}
	});
	return violations;
}

function main() {
	const present = SCAN_DIRS.filter((d) => existsSync(d));
	if (present.length === 0) {
		if (/^([a-z]:)?\/clusterio\/external_plugins\//i.test(SCRIPT_DIR.replace(/\\/g, "/"))) {
			console.log("lint:ps-silent — SKIPPED (plugin-only container mount; repo tools/ and tests/ not present)");
			return;
		}
		console.error("lint:ps-silent — FAILED: neither tools/ nor tests/ found at the repo root. A missing scan surface is not a pass.");
		process.exit(1);
	}
	const files = present.flatMap(collectPsFiles);
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
