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
 * TWO passes, because "has a citation" and "the citation points at something" are different questions.
 *
 * PASS 1 (code comments) — SHAPE. Any COMMENT in the scanned corpus making an empirical claim
 *   /verified empirically|empirically (verified|measured|proven)|\[empirical/i
 * MUST carry a citation-shaped string within +/-3 lines (lab rung / commit hash / Pitfall #N /
 * api-notes). Uncited claim => RED.
 *
 * PASS 2 (docs corpus) — RESOLVABILITY. Added 2026-07-25 after an audit found Pass 1 was a shape
 * check wearing the costume of a semantic check: it proved a citation-shaped string sat NEARBY, never
 * that it pointed at anything. Two concrete consequences were measured:
 *   (a) `api-notes` and `Pitfall #N` counted as evidence — PROSE CITING PROSE. The citation graph could
 *       close into a loop (code -> api-notes -> pitfalls -> api-notes) with NO measurement at its root.
 *   (b) the loose rung pattern collided with this repo's own requirement-numbering convention: the
 *       comment `-- R1: refuse a SECOND transfer` satisfied it as "evidence".
 * Pass 2 resolves every `[empirical, <pin>, <citation>]` tag in docs/ against a REAL artifact:
 *   - `tests/integration/<name>`  -> the test directory must exist
 *   - `pad <fixture-id>`          -> the fixture must exist in tests/lab-gallery/manifest.json
 *   - `<lab> <rung>`              -> must resolve in docs/evidence-index.json (keyed `<lab> <rung>`,
 *                                    because a bare rung is ambiguous across labs — fluid-lab R12 is
 *                                    not belt-lab R12; that collision really happened once, BELT-R8)
 * Anything else — including bare prose pointers — is RED. Do NOT self-approve an allow: allows are
 * escalations (memory: lint-allows-are-escalations).
 *
 * Evidence measured on an engine older than the current pin (tests/labs-certified.json) is CARRIED
 * FORWARD, not re-verified; docs/evidence-index.json records each rung's `measured_on` so that stays
 * visible. Never re-stamp a claim to the current pin without re-running the measurement.
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

// ---------- PASS 2: citation RESOLVABILITY in the docs corpus ----------
// The pass above is a SHAPE check: it proves a citation-shaped string sits near the claim, never that
// the citation points at anything. That is how a doc-cites-doc loop stayed green with no measurement at
// its root, and how `-- R1: refuse a SECOND transfer` (a REQUIREMENT id, not a lab rung) satisfied it.
// This pass resolves every `[empirical, <pin>, <citation>]` tag in the docs corpus against a real
// artifact: a live integration test, a live pad fixture, or an archived lab rung in the evidence index.
const docTargets = ["docs/factorio-2.0-api-notes.md", "docs/pitfalls.md"]
	.map((p) => join(REPO_DIR, p))
	.filter((p) => existsSync(p));

let index = { rungs: {} };
const INDEX_PATH = join(REPO_DIR, "docs", "evidence-index.json");
if (existsSync(INDEX_PATH)) index = JSON.parse(readFileSync(INDEX_PATH, "utf8"));
else errors.push("docs/evidence-index.json is missing — archived lab-rung citations cannot resolve.");

let manifestFixtures = new Set();
const MANIFEST_PATH = join(REPO_DIR, "tests", "lab-gallery", "manifest.json");
if (existsSync(MANIFEST_PATH)) {
	const m = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
	manifestFixtures = new Set((m.fixtures || []).map((f) => f.id));
}

let resolved = 0;
for (const file of docTargets) {
	const text = readFileSync(file, "utf8");
	const rel = relative(REPO_DIR, file).replaceAll("\\", "/");
	// multiline-aware: a tag may wrap across lines in prose
	for (const m of text.matchAll(/\[empirical,([^\]]*)\]/gs)) {
		const body = m[1].replace(/\s+/g, " ").trim();
		const line = text.slice(0, m.index).split("\n").length;
		// strip the leading pin (e.g. "2.0.77, ") to get the citation part
		const citation = body.replace(/^`?[\d.]+`?\s*,?\s*/, "").trim();
		// charter template examples: `<pin>`, `<citation>` — placeholders, not real citations
		if (!citation || /<[a-z-]+>/i.test(citation)) continue;
		resolved++;
		// A citation may name several artifacts ("state-dimensions-lab + pad omnibus-equipment-grid").
		const parts = citation.split(/\s*\+\s*/).map((s) => s.trim()).filter(Boolean);
		for (const part of parts) {
			if (part.startsWith("tests/integration/")) {
				if (!existsSync(join(REPO_DIR, part))) {
					errors.push(`${rel}:${line}: citation names a test that does not exist — "${part}"`);
				}
			} else if (/^pads?\s+/.test(part)) {
				for (const id of part.replace(/^pads?\s+/, "").split("/")) {
					if (!manifestFixtures.has(id.trim())) {
						errors.push(`${rel}:${line}: citation names a pad fixture not in the gallery manifest — "${id.trim()}"`);
					}
				}
			} else if (/lab|BELT-R/.test(part)) {
				// Archived lab rung, keyed `<lab> <rung>` in the index (a bare rung is ambiguous across labs
				// — fluid-lab R12 != belt-lab R12; a real collision already happened once, BELT-R8).
				// One citation may list several rungs of ONE lab: "BELT-R11/R12", "fluid-lab R1/R8",
				// "no-tick-sync-lab PR-0B/LAB-B5". Build candidate keys per rung and accept if any resolves;
				// that tolerates the shorthand second element ("R12" meaning "BELT-R12") without guessing.
				const isBelt = part.startsWith("BELT-R");
				const lab = isBelt ? "belt-lab" : part.split(/\s+/)[0];
				const rungText = isBelt ? part : part.slice(lab.length).trim();
				const rungs = rungText ? rungText.split("/").map((r) => r.trim()).filter(Boolean) : [];
				if (rungs.length === 0) {
					// lab-level citation (no rung named)
					if (!index.rungs[lab]) {
						errors.push(`${rel}:${line}: lab citation does not resolve in docs/evidence-index.json — "${lab}"`);
					}
					continue;
				}
				const firstPrefix = (rungs[0].match(/^[A-Za-z-]+/) || [""])[0]; // "BELT-R" / "R" / "PR-"
				for (const r of rungs) {
					const candidates = new Set([`${lab} ${r}`]);
					if (firstPrefix && !r.startsWith(firstPrefix)) {
						candidates.add(`${lab} ${firstPrefix}${r.replace(/^[A-Za-z-]+/, "")}`);
					}
					if (![...candidates].some((k) => index.rungs[k])) {
						errors.push(`${rel}:${line}: lab-rung citation does not resolve in docs/evidence-index.json — tried ${[...candidates].map((c) => `"${c}"`).join(" / ")}`);
					}
				}
			} else {
				errors.push(`${rel}:${line}: unrecognised citation form — "${part}" (want tests/integration/<name>, pad <fixture-id>, or a "<lab> <rung>" in the evidence index)`);
			}
		}
	}
}

if (errors.length > 0) {
	console.error(`lint-evidence-claims: ${errors.length} problem(s):\n`);
	for (const e of errors) console.error("  " + e);
	console.error(
		"\nan empirical claim needs evidence that RESOLVES — or the claim gets deleted.\n"
		+ "  code comments (pass 1): a citation-shaped string within +/-3 lines, same comment block.\n"
		+ "  docs (pass 2): the citation must point at a real artifact —\n"
		+ "    tests/integration/<name>   the test directory must exist\n"
		+ "    pad <fixture-id>           the fixture must exist in tests/lab-gallery/manifest.json\n"
		+ "    <lab> <rung>               must resolve in docs/evidence-index.json (keyed `<lab> <rung>`;\n"
		+ "                               a bare rung is ambiguous — fluid-lab R12 is not belt-lab R12)\n"
		+ "  A bare prose pointer (api-notes / Pitfall #N) is NOT terminal evidence in docs: prose citing\n"
		+ "  prose is how a citation loop stays green with no measurement at its root.\n"
		+ "  No artifact? Delete the claim — there is no [hypothesis] tier in the api-notes charter.\n"
		+ "For a verified false positive, add `lint-evidence-claims:allow <reason>` in the comment block "
		+ "AND enumerate it in scripts/lint-allow-manifest.json (allows are escalations, not self-service).",
	);
	process.exit(1);
}
console.log(`lint-evidence-claims: OK (${scanned} files scanned, ${claims} code claim(s) cited, ${resolved} doc citation(s) resolved)`);
