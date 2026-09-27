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

function checked(command, args, options, exec = run) {
	const result = exec(command, args, options);
	if (result.error) throw new Error(`${command} ${args[0]} failed: ${result.error.message}`);
	if (result.status !== 0) throw new Error(`${command} ${args[0]} exited ${result.status}: ${String(result.stderr).trim().slice(-2000)}`);
	return result;
}

export function isPlainRelative(value) {
	if (typeof value !== "string" || value === "" || value.includes("\\") || value.includes("\0")) return false;
	if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
	return value.split("/").every(segment => segment !== "" && segment !== "." && segment !== "..");
}

export function insideTree(root, relative) {
	const resolved = path.resolve(root, relative);
	const fromRoot = path.relative(path.resolve(root), resolved);
	if (!fromRoot || fromRoot.startsWith("..") || path.isAbsolute(fromRoot)) {
		throw new Error(`${relative} resolves outside the isolated export`);
	}
	return resolved;
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
		if (!Array.isArray(tests) || tests.length === 0
			|| tests.some(test => !isPlainRelative(test) || !test.startsWith("tests/") || !test.endsWith(".lua"))) {
			throw new Error(`${label}: "tests" must list one or more plain repo-relative .lua paths under tests/ (no "..", absolute or backslash paths)`);
		}
		const file = entry.file;
		if (!isPlainRelative(file) || !EXPORTED_PATHS.slice(0, 2).some(root => file.startsWith(root + "/")) || !file.endsWith(".lua")) {
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

export function uncommittedChanges(repo, paths = EXPORTED_PATHS, exec = run) {
	return checked("git", ["status", "--porcelain", "--untracked-files=all", "--", ...paths, `:(exclude)${DEPLOY_GENERATED}`], { cwd: repo }, exec)
		.stdout.split("\n").map(line => line.trimEnd()).filter(Boolean);
}

function exportTree(repo, destination, exec) {
	mkdirSync(destination, { recursive: true });
	const archive = checked("git", ["archive", "--format=tar", "HEAD", ...EXPORTED_PATHS], { cwd: repo, encoding: "buffer" }, exec);
	checked("tar", ["-xf", "-"], { cwd: destination, input: archive.stdout }, exec);
}

function luaImage(repo, exec) {
	const recipe = readFileSync(path.join(repo, DOCKERFILE));
	const image = `surface-export-lua-tests:${createHash("sha256").update(recipe).digest("hex").slice(0, 12)}`;
	checked("docker", ["build", "--quiet", "--tag", image, "-"], { input: recipe }, exec);
	return image;
}

// lua5.2 exits 1 for an uncaught error, which is how every Lua test fails. Anything else (Docker's
// 125/126/127, a kill, a timeout or a signal) means the test did not run to a verdict.
export function classifyExit(result, label) {
	if (result.error) throw new Error(`${label}: could not run docker: ${result.error.message}`);
	if (result.status === 0) return "pass";
	if (result.status === 1 && !result.signal) return "fail";
	const how = result.signal ? `signal ${result.signal}` : `exit ${result.status}`;
	const output = (String(result.stdout ?? "") + String(result.stderr ?? "")).trim().slice(-2000);
	throw new Error(`${label}: docker ended with ${how}, so the Lua run did not complete; no verdict is credited.\n${output}`);
}

function containerArgs(root, image) {
	return ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
		"--pids-limit", "32", "--memory", "128m", "-w", "/repo",
		"--mount", `type=bind,src=${root},dst=/repo,readonly`, image];
}

function runTest(root, image, test, exec) {
	insideTree(root, test);
	const result = exec("docker", [...containerArgs(root, image), test], {});
	const outcome = classifyExit(result, test);
	return { test, exitCode: result.status, outcome, output: (String(result.stdout) + String(result.stderr)).slice(-4000) };
}

function parses(root, image, file, exec) {
	insideTree(root, file);
	const result = exec("docker", [...containerArgs(root, image).slice(0, -1), "--entrypoint", "luac5.2", image, "-p", file], {});
	return { ok: classifyExit(result, `luac5.2 -p ${file}`) === "pass", output: String(result.stderr).trim() };
}

export function luaMutationRun(input, { repo = process.cwd(), log = console.log, exec = run } = {}) {
	const cases = normalizeCases(input);
	const dirty = uncommittedChanges(repo, EXPORTED_PATHS, exec);
	if (dirty.length > 0) {
		throw new Error("refusing: the exported paths have uncommitted changes, and this tool tests committed source (HEAD):\n"
			+ dirty.slice(0, 12).map(line => `  ${line}`).join("\n") + "\nCommit the change under test first.");
	}
	const head = checked("git", ["rev-parse", "HEAD"], { cwd: repo }, exec).stdout.trim();
	const directory = path.join(repo, "ci-artifacts", `lua-mutation-${randomUUID().slice(0, 12)}`);
	const root = path.join(directory, "tree");
	const report = { head, startedAt: new Date().toISOString(), baseline: [], results: [] };
	try {
		exportTree(repo, root, exec);
		const image = luaImage(repo, exec);
		report.image = image;
		const tests = [...new Set(cases.flatMap(entry => entry.tests))];
		for (const test of tests) {
			if (!existsSync(insideTree(root, test))) throw new Error(`${test} is not in the committed tree`);
			const outcome = runTest(root, image, test, exec);
			report.baseline.push(outcome);
			if (outcome.outcome !== "pass") {
				throw new Error(`baseline ${test} is already red (exit ${outcome.exitCode}) — a mutation verdict would be meaningless:\n${outcome.output}`);
			}
		}
		log(`baseline green: ${tests.join(", ")} at ${head.slice(0, 12)}`);
		for (const entry of cases) {
			const target = insideTree(root, entry.file);
			const original = existsSync(target) ? readFileSync(target, "utf8") : null;
			const mutation = original === null ? { applied: false, occurrences: 0 } : applyOnce(original, entry.find, entry.replace);
			const result = { name: entry.name, file: entry.file, tests: entry.tests };
			if (!mutation.applied) {
				result.verdict = "NOT APPLIED";
				result.detail = original === null ? "file not in the committed tree" : `find matched ${mutation.occurrences} times; it must match exactly once`;
			} else {
				writeFileSync(target, mutation.source);
				try {
					const syntax = parses(root, image, entry.file, exec);
					if (!syntax.ok) {
						result.verdict = "INVALID";
						result.detail = `mutant does not parse: ${syntax.output}`;
					} else {
						result.outcomes = entry.tests.map(test => runTest(root, image, test, exec));
						result.verdict = result.outcomes.some(outcome => outcome.outcome === "fail") ? "KILLED" : "SURVIVED";
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
