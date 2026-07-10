#!/usr/bin/env node
/**
 * lint-evidence-claims.mjs — an empirical claim in a code comment must carry its evidence.
 *
 * Paid for by a real incident: a comment in module/validators/transfer-validation.lua asserted the
 * strict-gate tolerances were "verified empirically" — but that verification never happened. The
 * false claim survived code review for weeks, and it was load-bearing: it justified the very
 * constants that authorize SOURCE DELETION on a transfer. A comment that CLAIMS measurement without
 * pointing at the measurement is worse than no comment — it manufactures unearned confidence in a
 * number that a reviewer then declines to re-question. (Same failure family as the ghost-buffer
 * mechanism that stood as law for four months; see the empirical-lab discipline in CLAUDE.md.)
 *
 * Rule: any COMMENT in the scanned corpus whose text makes an empirical claim — it matches
 *   /verified empirically|empirically (verified|measured|proven)|\[empirical/i
 * — MUST carry a CITATION somewhere in the same comment block (within +/-3 lines): one of
 *   - a lab rung reference      /LAB-[A-Z]|R\d+[a-d]?|B\d\b/   (e.g. "LAB-A", "R10b", "B7")
 *   - a commit hash             /\b[0-9a-f]{7,}\b/             (e.g. "d666b23")
 *   - a pitfall citation        /Pitfall #\d+/
 *   - an api-notes reference     /api-notes/                   (docs/factorio-2.0-api-notes.md)
 * An uncited empirical claim is RED. Either cite the evidence — the lab rung, the commit that
 * measured it, the pitfall, or the api-notes entry — or delete the claim. Do NOT self-approve an
 * allow: allows are escalations (memory: lint-allows-are-escalations).
 *
 * Scanned corpus (COMMENTS only — a string literal that happens to contain the phrase is not a
 * claim, and .md prose lives outside this guard, in lint-doc-refs):
 *   - module/ recursive .lua                  (all comments: line and block)
 *   - plugin-root .ts + lib/ .ts              (all comments: line and block)
 *   - scripts/ .mjs                           (HEADER block comment only; this guard excludes itself
 *                                              — its own header necessarily prints the trigger phrase)
 *   - <repo>/tests/ recursive .mjs + .ps1     (all comments: mjs line+block ; ps1 line+block)
 *
 * Run:   node scripts/lint-evidence-claims.mjs        (also: npm run lint:evidence-claims)
 * Escape hatch: put `lint-evidence-claims:allow <reason>` in the same comment block (within +/-3
 *               lines) AND enumerate it in scripts/lint-allow-manifest.json (allows are escalations).
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(SCRIPT_DIR, "..");
// scripts/ -> surface_export -> external_plugins -> seed-data -> docker -> <repo root>
const REPO_DIR = join(PLUGIN_DIR, "..", "..", "..", "..");
const SELF = fileURLToPath(import.meta.url);

const CLAIM_RE = /verified empirically|empirically (verified|measured|proven)|\[empirical/i;
const CITATION_RE = /LAB-[A-Z]|R\d+[a-d]?|B\d\b|\b[0-9a-f]{7,}\b|Pitfall #\d+|api-notes/;
const ALLOW_MARKER = "lint-evidence-claims:allow";
const WINDOW = 3;

// ---------- comment-family configuration ----------
const FAMILIES = {
	lua: { line: ["--"], blockOpen: "--[[", blockClose: "]]", strings: ['"', "'"] },
	c: { line: ["//"], blockOpen: "/*", blockClose: "*/", strings: ['"', "'", "`"] },
	ps: { line: ["#"], blockOpen: "<#", blockClose: "#>", strings: ['"', "'"] },
};
function familyFor(file) {
	const f = file.toLowerCase();
	if (f.endsWith(".lua")) return FAMILIES.lua;
	if (f.endsWith(".ps1")) return FAMILIES.ps;
	return FAMILIES.c; // .ts / .mjs / .js
}

/**
 * Extract the comment text on each physical line. Returns an array parallel to the file's lines,
 * each holding only the comment characters on that line ("" when the line has no comment). Block
 * comments carry across lines; strings are skipped so a delimiter inside a literal is not read as a
 * comment. (Line-spanning string literals — rare in this corpus — are not tracked across newlines.)
 */
function commentLinesOf(text, fam) {
	const lines = text.split(/\r?\n/);
	const out = [];
	let inBlock = false;
	for (const line of lines) {
		let buf = "";
		let i = 0;
		while (i < line.length) {
			if (inBlock) {
				const idx = line.indexOf(fam.blockClose, i);
				if (idx === -1) { buf += line.slice(i); i = line.length; }
				else { buf += line.slice(i, idx); i = idx + fam.blockClose.length; inBlock = false; }
				continue;
			}
			// Block comment open (must be checked before the line delimiter: "--[[" vs "--", "<#" vs "#").
			if (line.startsWith(fam.blockOpen, i)) { inBlock = true; i += fam.blockOpen.length; continue; }
			// Line comment: the rest of the line is comment.
			let lineDelim = null;
			for (const d of fam.line) { if (line.startsWith(d, i)) { lineDelim = d; break; } }
			if (lineDelim) { buf += line.slice(i + lineDelim.length); i = line.length; continue; }
			// String literal: skip to its close so an inner "--"/"//"/"#" is not treated as a comment.
			const ch = line[i];
			if (fam.strings.includes(ch)) {
				let j = i + 1;
				while (j < line.length) {
					if (line[j] === "\\") { j += 2; continue; }
					if (line[j] === ch) { j++; break; }
					j++;
				}
				i = j;
				continue;
			}
			i++;
		}
		out.push(buf);
	}
	return out;
}

// The header of a *.mjs is its leading comment region — every comment line before the first line
// that carries real code. Returns the exclusive end index.
function headerEnd(commentLines, text) {
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const codeOnLine = lines[i].slice(0, lines[i].length).trim();
		// A line is "code" if, after removing its comment portion, non-shebang, non-blank text remains.
		const withoutComment = commentLines[i] ? lines[i].replace(commentLines[i], "") : lines[i];
		const stripped = withoutComment.replace(/--\[\[|\]\]|\/\*|\*\/|\/\/|<#|#>|--|#/g, "").trim();
		if (i === 0 && stripped.startsWith("#!")) continue; // shebang
		if (stripped.length > 0) return i; // first real code line ends the header
	}
	return lines.length;
}

// ---------- collect the scan set ----------
function walk(dir, exts, out = []) {
	if (!existsSync(dir)) return out;
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === "dist" || name === ".git") continue;
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p, exts, out);
		else if (exts.some((e) => name.toLowerCase().endsWith(e))) out.push(p);
	}
	return out;
}
function filesIn(dir, exts) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.map((n) => join(dir, n))
		.filter((p) => statSync(p).isFile() && exts.some((e) => p.toLowerCase().endsWith(e)));
}

// { file, headerOnly } — headerOnly restricts the scan to the leading comment block (scripts/*.mjs).
const targets = [
	...walk(join(PLUGIN_DIR, "module"), [".lua"]).map((file) => ({ file, headerOnly: false })),
	...filesIn(PLUGIN_DIR, [".ts"]).map((file) => ({ file, headerOnly: false })),
	...filesIn(join(PLUGIN_DIR, "lib"), [".ts"]).map((file) => ({ file, headerOnly: false })),
	...filesIn(join(PLUGIN_DIR, "scripts"), [".mjs"])
		.filter((file) => file !== SELF) // this guard's own header prints the trigger phrase by necessity
		.map((file) => ({ file, headerOnly: true })),
	...walk(join(REPO_DIR, "tests"), [".mjs", ".ps1"]).map((file) => ({ file, headerOnly: false })),
];

// ---------- scan ----------
const errors = [];
let scanned = 0;
let claims = 0;
for (const { file, headerOnly } of targets) {
	scanned++;
	const text = readFileSync(file, "utf8");
	const fam = familyFor(file);
	const commentLines = commentLinesOf(text, fam);
	const limit = headerOnly ? headerEnd(commentLines, text) : commentLines.length;
	const rel = relative(REPO_DIR, file).replaceAll("\\", "/");

	for (let n = 0; n < limit; n++) {
		if (!CLAIM_RE.test(commentLines[n])) continue;
		claims++;
		const lo = Math.max(0, n - WINDOW);
		const hi = Math.min(commentLines.length - 1, n + WINDOW);
		let cited = false;
		let allowed = false;
		for (let k = lo; k <= hi; k++) {
			if (CITATION_RE.test(commentLines[k])) cited = true;
			if (commentLines[k].includes(ALLOW_MARKER)) allowed = true;
		}
		if (allowed) continue;
		if (!cited) {
			errors.push(
				`${rel}:${n + 1}: uncited empirical claim — "${commentLines[n].trim().slice(0, 90)}"`,
			);
		}
	}
}

if (errors.length > 0) {
	console.error(`lint-evidence-claims: ${errors.length} uncited empirical claim(s):\n`);
	for (const e of errors) console.error("  " + e);
	console.error(
		"\nan empirical claim needs its evidence: cite the lab rung, commit, or api-notes entry — or delete the claim.\n"
		+ "A citation (LAB-x / a commit hash / Pitfall #N / api-notes) must sit within +/-3 lines, in the same "
		+ "comment block. For a verified false positive, add `lint-evidence-claims:allow <reason>` in the comment "
		+ "block AND enumerate it in scripts/lint-allow-manifest.json (allows are escalations, not self-service).",
	);
	process.exit(1);
}
console.log(`lint-evidence-claims: OK (${scanned} files scanned, ${claims} empirical claim(s), all cited or allowed)`);
