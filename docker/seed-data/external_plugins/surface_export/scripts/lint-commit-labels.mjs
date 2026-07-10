#!/usr/bin/env node
/**
 * lint-commit-labels.mjs — commit labels are audit boundaries; this makes that mechanical.
 *
 * Reviewers and auditors allocate attention by commit label. A `docs(...)` commit that carries a
 * code-file diff is a rider that evades review — this class of defect shipped once through two
 * review passes (the original incident behind the CLAUDE.md rule), and then RECURRED in an agent's
 * lab-findings commit within days of the rule being restated in a brief. A rule that well-briefed
 * authors break twice is a machine's job.
 *
 * Rule enforced: any commit whose subject is labeled `docs:` / `docs(...)` may touch ONLY
 * documentation paths — `*.md` files anywhere, or anything under a `docs/` directory. Everything
 * else (a .lua/.ts/.mjs/.json/config diff) must live in its own honestly-labeled commit, even when
 * it is "comment-only": the label, not the diff's innocence, is what review attention keys on.
 *
 * Runs in CI as a dedicated PR step (checkout needs fetch-depth: 0) over `origin/<base>..HEAD`;
 * locally, run from anywhere in the repo — it diffs `origin/main..HEAD` (or `main..HEAD`).
 * If the range cannot be resolved the guard FAILS LOUDLY — it never silently passes.
 *
 * There is deliberately NO escape hatch: a genuinely mixed change is always splittable.
 * Note: on a squash-merge repo the PR TITLE becomes main's commit subject — the same rule applies
 * to PR titles at merge time; that half stays human (the owner merges).
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = join(SCRIPT_DIR, "..", "..", "..", "..", "..");

function git(...args) {
	return execFileSync("git", ["-C", REPO_DIR, ...args], { encoding: "utf8" }).trim();
}

const DOCS_LABEL_RE = /^docs[(:]/;
const isDocPath = (p) => p.toLowerCase().endsWith(".md") || /(^|\/)docs\//.test(p);

// Resolve the comparison base: CI passes BASE_REF; locally prefer origin/main, then main.
let base = null;
const candidates = process.env.BASE_REF
	? [`origin/${process.env.BASE_REF}`, process.env.BASE_REF]
	: ["origin/main", "main"];
for (const c of candidates) {
	try {
		git("rev-parse", "--verify", "--quiet", `${c}^{commit}`);
		base = c;
		break;
	} catch { /* try next */ }
}
if (!base) {
	console.error(
		`lint-commit-labels: cannot resolve a base ref (tried: ${candidates.join(", ")}). `
		+ "In CI, checkout with fetch-depth: 0 and pass BASE_REF; locally, fetch origin/main. "
		+ "This guard fails loudly rather than silently passing.",
	);
	process.exit(1);
}

let commits;
try {
	const raw = git("log", "--format=%H%x09%s", `${base}..HEAD`);
	commits = raw ? raw.split("\n").map((l) => {
		const [hash, ...rest] = l.split("\t");
		return { hash, subject: rest.join("\t") };
	}) : [];
} catch (e) {
	console.error(`lint-commit-labels: git log ${base}..HEAD failed: ${e.message}`);
	process.exit(1);
}

const errors = [];
let docsCommits = 0;
for (const { hash, subject } of commits) {
	if (!DOCS_LABEL_RE.test(subject)) continue;
	docsCommits++;
	const files = git("show", "--name-only", "--format=", hash).split("\n").filter(Boolean);
	const riders = files.filter((f) => !isDocPath(f));
	if (riders.length > 0) {
		errors.push(
			`${hash.slice(0, 7)} "${subject}" is labeled docs but touches non-doc files:\n`
			+ riders.map((f) => `      ${f}`).join("\n")
			+ "\n    Split the non-doc diff into its own honestly-labeled commit (even comment-only code changes).",
		);
	}
}

if (errors.length > 0) {
	console.error(`lint-commit-labels: ${errors.length} mislabeled commit(s) in ${base}..HEAD:\n`);
	for (const e of errors) console.error("  " + e + "\n");
	console.error("Commit labels are audit boundaries — reviewers allocate attention by label. No escape hatch; split the commit.");
	process.exit(1);
}
console.log(`lint-commit-labels: OK (${commits.length} commits in ${base}..HEAD, ${docsCommits} docs-labeled, 0 riders)`);
