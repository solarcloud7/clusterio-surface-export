import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const HEALTH_WAIT = /docker inspect --format="\{\{\.State\.Health\.Status\}\}"[^\n|]*\|\s*(grep[^;\n]*);/g;

function resolveGrep() {
	const candidates = ["grep"];
	const gitExecPath = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
	if (gitExecPath.status === 0) {
		candidates.push(resolve(gitExecPath.stdout.trim(), "..", "..", "..", "usr", "bin", "grep.exe"));
	}
	return candidates.find(candidate => spawnSync(candidate, ["--version"]).status === 0);
}

const GREP = resolveGrep();

function healthPredicates() {
	const workflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
	return [...workflow.matchAll(HEALTH_WAIT)].map(match => match[1].trim().split(/\s+/));
}

function accepts(argv, input) {
	assert.ok(GREP, "no grep on PATH, and none derivable from `git --exec-path` — this pin cannot run");
	const result = spawnSync(GREP, argv.slice(1), { input });
	if (result.error) {
		assert.fail(`could not run \`${argv.join(" ")}\`: ${result.error.message}`);
	}
	return result.status === 0;
}

test("every controller health wait in ci.yml is extracted, so the runs below are not vacuous", () => {
	const predicates = healthPredicates();
	assert.ok(predicates.length >= 2,
		`ci.yml has ${predicates.length} extractable controller health waits; the assertions below would test nothing`);
	for (const argv of predicates) {
		assert.equal(argv[0], "grep", `unrecognised health predicate: ${argv.join(" ")}`);
	}
});

test("every controller health wait REFUSES the literal status unhealthy", () => {
	for (const argv of healthPredicates()) {
		for (const status of ["unhealthy", "unhealthy\n"]) {
			assert.equal(accepts(argv, status), false,
				`\`${argv.join(" ")}\` accepted ${JSON.stringify(status)} as healthy`);
		}
	}
});

test("every controller health wait ACCEPTS healthy — the control arm", () => {
	for (const argv of healthPredicates()) {
		for (const status of ["healthy", "healthy\n"]) {
			assert.equal(accepts(argv, status), true,
				`\`${argv.join(" ")}\` rejected ${JSON.stringify(status)}, so refusing unhealthy proves nothing`);
		}
	}
});

test("starting and a missing container are refused, never read as healthy", () => {
	for (const argv of healthPredicates()) {
		for (const status of ["starting\n", ""]) {
			assert.equal(accepts(argv, status), false,
				`\`${argv.join(" ")}\` accepted ${JSON.stringify(status)}`);
		}
	}
});

test("the substring predicate this replaced accepts unhealthy — the pin discriminates", () => {
	assert.equal(accepts(["grep", "-q", "healthy"], "unhealthy\n"), true);
	assert.equal(accepts(["grep", "-qx", "healthy"], "unhealthy\n"), false);
});
