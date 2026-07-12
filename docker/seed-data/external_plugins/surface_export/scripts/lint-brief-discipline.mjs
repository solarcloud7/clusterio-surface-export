#!/usr/bin/env node
/** Require newly added or modified execution briefs to link the canonical discipline. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = join(SCRIPT_DIR, "..", "..", "..", "..", "..");
const DISCIPLINE_LINK = "[Agent execution discipline](../../AGENT_EXECUTION_DISCIPLINE.md)";
const BRIEF_RE = /(?:-agent)?-brief\.md$/i;

export function findBriefDisciplineViolations(files) {
	return files
		.filter(({ status, path }) => /^[AM]/.test(status) && BRIEF_RE.test(basename(path)))
		.filter(({ content }) => !content.includes(DISCIPLINE_LINK))
		.map(({ status, path }) => ({ status, path }));
}

function git(...args) {
	return execFileSync("git", ["-C", REPO_DIR, ...args], { encoding: "utf8" }).trim();
}

function resolveBase() {
	const candidates = process.env.BASE_REF ? [`origin/${process.env.BASE_REF}`, process.env.BASE_REF] : ["origin/main", "main"];
	for (const candidate of candidates) {
		try {
			git("rev-parse", "--verify", "--quiet", `${candidate}^{commit}`);
			return candidate;
		} catch { /* try next */ }
	}
	throw new Error(`cannot resolve a base ref (tried: ${candidates.join(", ")}); fetch the PR base and pass BASE_REF`);
}

function changedFiles(base) {
	const output = git("diff", "--name-status", "--diff-filter=AM", `${base}...HEAD`);
	if (!output) return [];
	return output.split("\n").map((line) => {
		const [status, ...pathParts] = line.split("\t");
		const path = pathParts.join("\t");
		return { status, path, content: readFileSync(join(REPO_DIR, path), "utf8") };
	});
}

function main() {
	let base;
	try {
		base = resolveBase();
	} catch (error) {
		console.error(`lint-brief-discipline: ${error.message}`);
		process.exit(1);
	}
	const violations = findBriefDisciplineViolations(changedFiles(base));
	if (violations.length > 0) {
		console.error(`lint-brief-discipline: ${violations.length} brief(s) in ${base}...HEAD omit the canonical discipline link:`);
		for (const { path } of violations) console.error(`  ${path}`);
		console.error(`Required link: ${DISCIPLINE_LINK}`);
		process.exit(1);
	}
	console.log(`lint-brief-discipline: OK (${base}...HEAD)`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
