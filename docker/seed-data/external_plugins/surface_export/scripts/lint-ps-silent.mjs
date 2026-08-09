#!/usr/bin/env node

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..", "..", "..", "..", "..");
const SCAN_DIRS = [join(REPO_ROOT, "tools"), join(REPO_ROOT, "tests")];

const ANNOTATION = /deliberately quiet|intentional probe/i;
const SUPPRESSIONS = [
	{ id: "stderr-to-null", regex: /[2*]>\s*\$null/i, checkMark: /\$LASTEXITCODE|\$\?/ },
	{ id: "merged-discard", regex: /2>&1\s*\|\s*Out-Null/i, checkMark: /\$LASTEXITCODE|\$\?/ },
	{ id: "silently-continue", regex: /-(?:EA|ErrorAction)[\s:]+['"]?(?:SilentlyContinue|Ignore)\b/i, checkMark: /\$\?/ },
	{ id: "preference-silence", regex: /\$ErrorActionPreference\s*=\s*['"](?:SilentlyContinue|Ignore)['"]/i, checkMark: null },
];
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
	const checked = (i, mark) => mark !== null && mark.test(stripped.slice(i, Math.min(stripped.length, i + 4)).join("\n"));

	stripped.forEach((code, i) => {
		for (const rule of SUPPRESSIONS) {
			if (!rule.regex.test(code)) continue;
			if (annotated(i) || checked(i, rule.checkMark)) continue;
			violations.push({ file: relPath, line: i + 1, id: rule.id, text: lines[i].trim() });
		}
	});

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
