// lua-mutation — guard-removal checks for module/ Lua, run against committed source in isolation.
// requires: docker; a git checkout whose exported paths (module/, mods-src/surfexp_gateways, tests/) have no
//           uncommitted or untracked changes; mutation cases naming an exact string that occurs once
// produces: per case KILLED / SURVIVED / INVALID (mutant does not parse) / NOT APPLIED, after a green
//           baseline of every named test on the same export; evidence under ci-artifacts/lua-mutation-<id>/
// does not: touch the working tree or the live plugin mount (the export is a git archive of HEAD mounted
//           read-only into the CI Lua 5.2 image), run Factorio, or prove anything beyond the named tests

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

export const EXPORTED_PATHS = [
	"docker/seed-data/external_plugins/surface_export/module",
	"docker/seed-data/mods-src/surfexp_gateways",
	"tests",
];
const DOCKERFILE = "tools/clusterio/lua-tests.Dockerfile";

function run(command, args, options = {}) {
	return spawnSync(command, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 600_000, ...options });
}

function checked(command, args, options) {
	const result = run(command, args, options);
	if (result.error) throw new Error(`${command} ${args[0]} failed: ${result.error.message}`);
	if (result.status !== 0) throw new Error(`${command} ${args[0]} exited ${result.status}: ${String(result.stderr).trim().slice(-2000)}`);
	return result;
}

export function normalizeCases(input) {
	const list = Array.isArray(input) ? input : [input];
	if (list.length === 0) throw new Error("no mutation cases given");
	const names = new Set();
	return list.map((entry, index) => {
		const label = entry?.name || `case ${index + 1}`;
		for (const key of ["name", "file", "find"]) {
			if (typeof entry?.[key] !== "string" || entry[key] === "") throw new Error(`${label}: "${key}" must be a nonempty string`);
		}
		if (typeof entry.replace !== "string") throw new Error(`${label}: "replace" must be a string (use "" to delete)`);
		if (entry.find === entry.replace) throw new Error(`${label}: find and replace are identical — that is not a mutation`);
		const tests = typeof entry.tests === "string" ? [entry.tests] : entry.tests;
		if (!Array.isArray(tests) || tests.length === 0 || tests.some(test => typeof test !== "string" || !test.startsWith("tests/"))) {
			throw new Error(`${label}: "tests" must list one or more repo-relative paths under tests/`);
		}
		const file = entry.file.replace(/\\/g, "/");
		if (!EXPORTED_PATHS.some(root => file.startsWith(root + "/")) || !file.endsWith(".lua")) {
			throw new Error(`${label}: ${file} is not a Lua file under ${EXPORTED_PATHS.slice(0, 2).join(" or ")}`);
		}
		if (names.has(entry.name)) throw new Error(`${label}: duplicate case name`);
		names.add(entry.name);
		return { name: entry.name, file, find: entry.find, replace: entry.replace, tests };
	});
}

export function applyOnce(source, find, replace) {
	const parts = source.split(find);
	if (parts.length !== 2) return { applied: false, occurrences: parts.length - 1 };
	return { applied: true, source: parts[0] + replace + parts[1] };
}

export function summarize(results) {
	const counts = { killed: 0, survived: 0, invalid: 0, notApplied: 0 };
	for (const result of results) {
		if (result.verdict === "KILLED") counts.killed++;
		else if (result.verdict === "SURVIVED") counts.survived++;
		else if (result.verdict === "INVALID") counts.invalid++;
		else counts.notApplied++;
	}
	return { ...counts, ok: counts.killed === results.length };
}

const DEPLOY_GENERATED = "docker/seed-data/external_plugins/surface_export/module/build-id.lua";

export function uncommittedChanges(repo, paths = EXPORTED_PATHS) {
	return checked("git", ["status", "--porcelain", "--untracked-files=all", "--", ...paths, `:(exclude)${DEPLOY_GENERATED}`], { cwd: repo })
		.stdout.split("\n").map(line => line.trimEnd()).filter(Boolean);
}

function exportTree(repo, destination) {
	mkdirSync(destination, { recursive: true });
	const archive = checked("git", ["archive", "--format=tar", "HEAD", ...EXPORTED_PATHS], { cwd: repo, encoding: "buffer" });
	checked("tar", ["-xf", "-"], { cwd: destination, input: archive.stdout });
}

function luaImage(repo) {
	const recipe = readFileSync(path.join(repo, DOCKERFILE));
	const image = `surface-export-lua-tests:${createHash("sha256").update(recipe).digest("hex").slice(0, 12)}`;
	checked("docker", ["build", "--quiet", "--tag", image, "-"], { input: recipe });
	return image;
}

function containerArgs(root, image) {
	return ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
		"--pids-limit", "32", "--memory", "128m", "-w", "/repo",
		"--mount", `type=bind,src=${root},dst=/repo,readonly`, image];
}

function runTest(root, image, test) {
	const result = run("docker", [...containerArgs(root, image), test]);
	if (result.error) throw new Error(`docker run failed: ${result.error.message}`);
	return { test, exitCode: result.status, output: (String(result.stdout) + String(result.stderr)).slice(-4000) };
}

function parses(root, image, file) {
	const result = run("docker", [...containerArgs(root, image).slice(0, -1), "--entrypoint", "luac5.2", image, "-p", file]);
	if (result.error) throw new Error(`docker run failed: ${result.error.message}`);
	return { ok: result.status === 0, output: String(result.stderr).trim() };
}

export function luaMutationRun(input, { repo = process.cwd(), log = console.log } = {}) {
	const cases = normalizeCases(input);
	const dirty = uncommittedChanges(repo);
	if (dirty.length > 0) {
		throw new Error("refusing: the exported paths have uncommitted changes, and this tool tests committed source (HEAD):\n"
			+ dirty.slice(0, 12).map(line => `  ${line}`).join("\n") + "\nCommit the change under test first.");
	}
	const head = checked("git", ["rev-parse", "HEAD"], { cwd: repo }).stdout.trim();
	const directory = path.join(repo, "ci-artifacts", `lua-mutation-${randomUUID().slice(0, 12)}`);
	const root = path.join(directory, "tree");
	const report = { head, startedAt: new Date().toISOString(), baseline: [], results: [] };
	try {
		exportTree(repo, root);
		const image = luaImage(repo);
		report.image = image;
		const tests = [...new Set(cases.flatMap(entry => entry.tests))];
		for (const test of tests) {
			if (!existsSync(path.join(root, test))) throw new Error(`${test} is not in the committed tree`);
			const outcome = runTest(root, image, test);
			report.baseline.push(outcome);
			if (outcome.exitCode !== 0) {
				throw new Error(`baseline ${test} is already red (exit ${outcome.exitCode}) — a mutation verdict would be meaningless:\n${outcome.output}`);
			}
		}
		log(`baseline green: ${tests.join(", ")} at ${head.slice(0, 12)}`);
		for (const entry of cases) {
			const target = path.join(root, entry.file);
			const original = existsSync(target) ? readFileSync(target, "utf8") : null;
			const mutation = original === null ? { applied: false, occurrences: 0 } : applyOnce(original, entry.find, entry.replace);
			const result = { name: entry.name, file: entry.file, tests: entry.tests };
			if (!mutation.applied) {
				result.verdict = "NOT APPLIED";
				result.detail = original === null ? "file not in the committed tree" : `find matched ${mutation.occurrences} times; it must match exactly once`;
			} else {
				writeFileSync(target, mutation.source);
				try {
					const syntax = parses(root, image, entry.file);
					if (!syntax.ok) {
						result.verdict = "INVALID";
						result.detail = `mutant does not parse: ${syntax.output}`;
					} else {
						result.outcomes = entry.tests.map(test => runTest(root, image, test));
						result.verdict = result.outcomes.some(outcome => outcome.exitCode !== 0) ? "KILLED" : "SURVIVED";
					}
				} finally { writeFileSync(target, original); }
			}
			report.results.push(result);
			log(`${result.verdict.padEnd(11)} ${entry.name}${result.detail ? ` — ${result.detail}` : ""}`);
		}
		report.summary = summarize(report.results);
		return report;
	} finally {
		report.finishedAt = new Date().toISOString();
		mkdirSync(directory, { recursive: true });
		rmSync(root, { recursive: true, force: true });
		writeFileSync(path.join(directory, "result.json"), JSON.stringify(report, null, 2) + "\n");
		log(`evidence: ${path.join(directory, "result.json")}`);
	}
}
