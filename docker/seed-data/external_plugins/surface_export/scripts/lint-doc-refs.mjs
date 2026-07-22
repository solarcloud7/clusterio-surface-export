#!/usr/bin/env node
/**
 * lint-doc-refs.mjs — guard for the pitfall registry and HUMAN-RESOLVABLE documentation citations.
 *
 * Exists because reference rot in the pitfall corpus caused real damage twice:
 *   - CLAUDE.md carried TWO "### 20." pitfalls for months (the collision was only found when the
 *     owner asked what "Pitfall #20" even meant), and #8 was silently retired — so a bare number
 *     could cite nothing, or the WRONG thing.
 *   - Pure-pointer citations ("(same as §E)", "see Pitfall #29") forced every reader through a
 *     lookup; the owner's verdict: "Those references mean nothing to a human." The convention is
 *     number + short name — and a fresh reader still broke that rule within 48h of it being
 *     written. A rule humans break that fast needs a machine.
 *
 * The corpus is now STRUCTURED (2026-07-20): docs/pitfalls.json is the registry (stable slug,
 * frozen legacy number, status, rule, guard), docs/pitfalls.md holds the prose bodies, and
 * CLAUDE.md carries a compact index table. This guard holds all three consistent:
 *
 *   registry-schema        pitfalls.json entries are well-formed; numbers and slugs are unique;
 *                          status is one of active|historical|revision-queued|refuted.
 *   registry-body-sync     every registry number has exactly one "### N. Title" body in
 *                          docs/pitfalls.md, and vice versa.
 *   registry-index-sync    every registry number and slug appears in CLAUDE.md's pitfall index
 *                          table; CLAUDE.md defines no "### N." pitfall bodies of its own.
 *   unknown-pitfall-ref    every "Pitfall #N" citation resolves to a registry number.
 *   pure-pointer-citation  a parenthetical or "See ..." sentence whose ENTIRE content is the
 *                          reference carries zero meaning for a human — add the short name:
 *                            BAD:  (Pitfall #19)   (see CLAUDE.md Pitfall #19)   (same as §E)
 *                            GOOD: (Pitfall #19, platform.destroy is a no-op)
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
const STATUSES = new Set(["active", "historical", "revision-queued", "refuted"]);

const errors = [];

// ---------- registry-schema ----------
const registryPath = join(REPO_DIR, "docs", "pitfalls.json");
let registry = [];
try {
	registry = JSON.parse(readFileSync(registryPath, "utf8")).pitfalls;
} catch (err) {
	console.error(`lint-doc-refs: cannot read/parse docs/pitfalls.json: ${err.message}`);
	process.exit(1);
}
const pitfalls = new Map(); // number -> entry
const slugs = new Map(); // slug -> entry
for (const p of registry) {
	for (const field of ["number", "slug", "title", "status", "rule"]) {
		if (p[field] === undefined || p[field] === null || p[field] === "") {
			errors.push(`pitfalls.json: registry-schema — entry ${JSON.stringify(p.slug ?? p.number)} missing "${field}".`);
		}
	}
	if (!Number.isInteger(p.number) || p.number < 1) {
		errors.push(`pitfalls.json: registry-schema — "${p.slug}" has non-positive-integer number ${p.number}.`);
	}
	if (!STATUSES.has(p.status)) {
		errors.push(`pitfalls.json: registry-schema — "${p.slug}" has invalid status "${p.status}" (valid: ${[...STATUSES].join(", ")}).`);
	}
	if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(p.slug ?? "")) {
		errors.push(`pitfalls.json: registry-schema — slug "${p.slug}" is not kebab-case.`);
	}
	if (pitfalls.has(p.number)) {
		errors.push(`pitfalls.json: registry-schema — number ${p.number} defined twice ("${pitfalls.get(p.number).slug}" AND "${p.slug}"). Numbers are frozen aliases — never reuse.`);
	}
	if (slugs.has(p.slug)) {
		errors.push(`pitfalls.json: registry-schema — slug "${p.slug}" defined twice.`);
	}
	pitfalls.set(p.number, p);
	slugs.set(p.slug, p);
}
if (pitfalls.size === 0) {
	console.error("lint-doc-refs: docs/pitfalls.json contains no pitfalls — registry wrong?");
	process.exit(1);
}

// ---------- registry-body-sync (docs/pitfalls.md) ----------
const bodiesPath = join(REPO_DIR, "docs", "pitfalls.md");
const bodiesText = existsSync(bodiesPath) ? readFileSync(bodiesPath, "utf8") : "";
if (!bodiesText) {
	errors.push("docs/pitfalls.md: registry-body-sync — file missing; the prose bodies live here.");
}
const bodyNums = new Map(); // number -> heading title
for (const m of bodiesText.matchAll(/^### (\d+)\. (.+)$/gm)) {
	const num = Number(m[1]);
	if (bodyNums.has(num)) {
		errors.push(`pitfalls.md: registry-body-sync — "### ${num}." is defined twice ("${bodyNums.get(num)}" AND "${m[2].trim()}").`);
	} else {
		bodyNums.set(num, m[2].trim());
	}
}
for (const n of pitfalls.keys()) {
	if (!bodyNums.has(n)) errors.push(`pitfalls.md: registry-body-sync — registry #${n} ("${pitfalls.get(n).slug}") has no "### ${n}." body.`);
}
for (const n of bodyNums.keys()) {
	if (!pitfalls.has(n)) errors.push(`pitfalls.md: registry-body-sync — body "### ${n}. ${bodyNums.get(n)}" is not in the registry.`);
}

// ---------- registry-index-sync (CLAUDE.md table; no stray bodies) ----------
const claudeMd = readFileSync(join(REPO_DIR, "CLAUDE.md"), "utf8");
for (const m of claudeMd.matchAll(/^### (\d+)\. (.+)$/gm)) {
	errors.push(`CLAUDE.md: registry-index-sync — pitfall body "### ${m[1]}. ${m[2].trim()}" belongs in docs/pitfalls.md, not CLAUDE.md.`);
}
for (const p of pitfalls.values()) {
	const rowRe = new RegExp(String.raw`^\| ${p.number} \| \`${p.slug}\` \|`, "m");
	if (!rowRe.test(claudeMd)) {
		errors.push(`CLAUDE.md: registry-index-sync — index table has no row "| ${p.number} | \`${p.slug}\` | ..." for that pitfall.`);
	}
}
for (const m of claudeMd.matchAll(/^\| (\d+) \| `([a-z0-9-]+)` \|/gm)) {
	const num = Number(m[1]);
	if (!pitfalls.has(num) || pitfalls.get(num).slug !== m[2]) {
		errors.push(`CLAUDE.md: registry-index-sync — table row "| ${m[1]} | \`${m[2]}\` |" does not match the registry.`);
	}
}

// ---------- collect the citation scan set ----------
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
	...mdFilesIn(join(REPO_DIR, "docs")), // docs/*.md — deliberately NOT recursive
	...mdFilesIn(join(PLUGIN_DIR, "docs"), true), // plugin docs
];

// ---------- citation rules ----------
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

		// Rule: unknown-pitfall-ref.
		for (const m of flat.matchAll(CITATION_RE)) {
			const num = Number(m[1]);
			if (!pitfalls.has(num) && !allowed) {
				errors.push(
					`${rel}:~${paraStartLine}: unknown-pitfall-ref — cites Pitfall #${num}, which is not in docs/pitfalls.json `
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
				? ` — write "(Pitfall #${num}, ${pitfalls.get(num).title})"`
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
		"\nThe registry (docs/pitfalls.json), the bodies (docs/pitfalls.md), and the CLAUDE.md index table "
		+ "must agree; a citation must be resolvable AND readable in place: number + short name "
		+ '(e.g. "Pitfall #19, platform.destroy is a no-op"). '
		+ "For a verified false positive, add `lint-doc-refs:allow <reason>` in the paragraph "
		+ "AND list it in scripts/lint-allow-manifest.json (allows are escalations).",
	);
	process.exit(1);
}
console.log(
	`lint-doc-refs: OK (${files.length} files scanned, ${pitfalls.size} pitfalls in the registry, `
	+ `${bodyNums.size} bodies, 0 problems)`,
);
