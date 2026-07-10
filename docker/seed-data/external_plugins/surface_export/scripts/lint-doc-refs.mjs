#!/usr/bin/env node
/**
 * lint-doc-refs.mjs — static guard for HUMAN-RESOLVABLE documentation cross-references.
 *
 * Exists because reference rot in the pitfall corpus caused real damage twice:
 *   - CLAUDE.md carried TWO "### 20." pitfalls for months (the collision was only found when the
 *     owner asked what "Pitfall #20" even meant), and #8 was silently retired — so a bare number
 *     could cite nothing, or the WRONG thing.
 *   - Pure-pointer citations ("(same as §E)", "see Pitfall #29") forced every reader through a
 *     lookup; the owner's verdict: "Those references mean nothing to a human." CLAUDE.md now
 *     mandates number + short name — and a fresh reader still broke that rule within 48h of it
 *     being written. A rule humans break that fast needs a machine.
 *
 * Rules (scanned over root *.md + docs/*.md + the plugin's docs/*.md; docs/superpowers/** is
 * excluded — those are frozen historical plan/brief records, not living reference docs):
 *   duplicate-pitfall-number  CLAUDE.md must not define the same "### N." twice.
 *   unknown-pitfall-ref       every "Pitfall #N" must cite a number that exists in CLAUDE.md.
 *   pure-pointer-citation     a parenthetical or "See ..." sentence whose ENTIRE content is the
 *                             reference (plus stopwords like "see"/"CLAUDE.md") carries zero
 *                             meaning for a human — add the short name:
 *                               BAD:  (Pitfall #19)   (see CLAUDE.md Pitfall #19)   (same as §E)
 *                               GOOD: (Pitfall #19, platform.destroy is a no-op)
 *                             Context BEFORE the citation also counts — only parentheticals/
 *                             sentences that contain NOTHING but the pointer are flagged.
 *
 * Run:   node scripts/lint-doc-refs.mjs        (also: npm run lint:doc-refs)
 * Escape hatch: put `lint-doc-refs:allow` (with a reason) in the same paragraph — and list it in
 *               scripts/lint-allow-manifest.json (allows are escalations, not self-service).
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(SCRIPT_DIR, "..");
const REPO_DIR = join(PLUGIN_DIR, "..", "..", "..", "..");
const ALLOW_MARKER = "lint-doc-refs:allow";

// ---------- collect the scan set ----------
function mdFilesIn(dir, recursive = false) {
	if (!existsSync(dir)) return [];
	const out = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) {
			if (recursive) out.push(...mdFilesIn(p, true));
		} else if (name.toLowerCase().endsWith(".md")) {
			out.push(p);
		}
	}
	return out;
}

const files = [
	...mdFilesIn(REPO_DIR), // root-level *.md (CLAUDE.md, README.md, ...)
	...mdFilesIn(join(REPO_DIR, "docs")), // docs/*.md — deliberately NOT recursive (excludes docs/superpowers/**)
	...mdFilesIn(join(PLUGIN_DIR, "docs"), true), // plugin docs
];

// ---------- build the pitfall map from CLAUDE.md ----------
const claudeMdPath = join(REPO_DIR, "CLAUDE.md");
const claudeMd = readFileSync(claudeMdPath, "utf8");
const pitfalls = new Map(); // number -> name
const errors = [];

for (const m of claudeMd.matchAll(/^### (\d+)\. (.+)$/gm)) {
	const num = Number(m[1]);
	const name = m[2].trim();
	if (pitfalls.has(num)) {
		errors.push(
			`CLAUDE.md: duplicate-pitfall-number — "### ${num}." is defined twice `
			+ `("${pitfalls.get(num)}" AND "${name}"). Renumber one (see the numbering note; the second #20 became #32).`,
		);
	} else {
		pitfalls.set(num, name);
	}
}
if (pitfalls.size === 0) {
	console.error("lint-doc-refs: could not parse any '### N. Title' pitfall headings from CLAUDE.md — scan set wrong?");
	process.exit(1);
}

// ---------- helpers ----------
const CITATION_RE = /Pitfall\s*#(\d+)/g;
// Words that add no human-resolvable meaning to a pointer.
const STOPWORDS_RE = new RegExp(
	[
		/Pitfall\s*#\d+/.source,
		/CLAUDE\.md/.source,
		/AGENTS\.md/.source,
		/ENGINEERING_FAQ(?:\.md)?/.source,
		/§\s*[A-Z]\w*/.source,
		/PR\s*#\d+/.source,
		/\b(?:see|also|same|as|answer|cf|in|and|the|a|an|of|note|via|per)\b/.source,
	].join("|"),
	"gi",
);
const hasRealContent = (s) => /[A-Za-z]{3,}/.test(s.replace(STOPWORDS_RE, " "));

// ---------- scan ----------
for (const file of files) {
	const rel = relative(REPO_DIR, file).replaceAll("\\", "/");
	const text = readFileSync(file, "utf8");
	// Work per-paragraph so wrapped sentences/parentheticals are seen whole.
	const paragraphs = text.split(/\r?\n\s*\r?\n/);
	let lineNo = 1;
	for (const para of paragraphs) {
		const paraStartLine = lineNo;
		lineNo += para.split(/\r?\n/).length + 1;
		const allowed = para.includes(ALLOW_MARKER);
		const flat = para.replace(/\s+/g, " ");

		// Rule: unknown-pitfall-ref (skip CLAUDE.md's own heading lines — they DEFINE the numbers).
		for (const m of flat.matchAll(CITATION_RE)) {
			const num = Number(m[1]);
			if (!pitfalls.has(num) && !allowed) {
				errors.push(
					`${rel}:~${paraStartLine}: unknown-pitfall-ref — cites Pitfall #${num}, which does not exist in CLAUDE.md `
					+ `(valid: ${[...pitfalls.keys()].sort((a, b) => a - b).join(", ")}). Renumbered? Fix the citation.`,
				);
			}
		}
		if (allowed) continue;

		// Rule: pure-pointer-citation — parentheticals whose whole content is the reference.
		for (const m of flat.matchAll(/\(([^()]{0,200}?)\)/g)) {
			const inner = m[1];
			if (!/Pitfall\s*#\d+|§\s*[A-Z]/.test(inner)) continue;
			if (hasRealContent(inner)) continue;
			const cited = inner.match(CITATION_RE)?.[0];
			const num = cited ? Number(cited.match(/\d+/)[0]) : null;
			const suggestion = num !== null && pitfalls.has(num)
				? ` — write "(Pitfall #${num}, ${pitfalls.get(num).replace(/ \(.*$/, "")})"`
				: " — add the short name / a human-readable description";
			errors.push(`${rel}:~${paraStartLine}: pure-pointer-citation — "(${inner})" means nothing without a lookup${suggestion}.`);
		}

		// Rule: pure-pointer "See ..." sentences.
		for (const m of flat.matchAll(/(?:^|\.\s+)((?:See|Same as)\s[^.]{0,80}?)\.(?:\s|$)/gi)) {
			const sentence = m[1];
			if (!/Pitfall\s*#\d+|§\s*[A-Z]/.test(sentence)) continue;
			if (hasRealContent(sentence)) continue;
			errors.push(`${rel}:~${paraStartLine}: pure-pointer-citation — "${sentence}." names no content — append the short name.`);
		}
	}
}

if (errors.length > 0) {
	console.error(`lint-doc-refs: ${errors.length} problem(s):\n`);
	for (const e of errors) console.error("  " + e);
	console.error(
		"\nA citation must be resolvable AND readable in place: number + short name "
		+ '(e.g. "Pitfall #19, platform.destroy is a no-op"). '
		+ "For a verified false positive, add `lint-doc-refs:allow <reason>` in the paragraph "
		+ "AND list it in scripts/lint-allow-manifest.json (allows are escalations).",
	);
	process.exit(1);
}
console.log(`lint-doc-refs: OK (${files.length} files scanned, ${pitfalls.size} pitfalls in the index, 0 problems)`);
