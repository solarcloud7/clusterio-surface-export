import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EXIT_TIMEOUT } from "../../tools/clusterio/ci-await-seeding.mjs";
import { EXIT_GENERATED_WORLD } from "../../tools/clusterio/ci-verify-seeded-boot.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STEP_NAME = "Wait for seeding, and verify both instances booted their seeded save";

function bringUpStep() {
	const workflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
	const after = workflow.split(`- name: ${STEP_NAME}`);
	assert.equal(after.length, 2, `.github/workflows/ci.yml has no single step named "${STEP_NAME}"`);
	const body = after[1].split(/^ {6}- name: /m)[0];
	assert.ok(body.includes("run: |"), "the bring-up step has no run block");
	return body;
}

test("the bring-up step runs the seeding wait before the seeded-boot check", () => {
	const step = bringUpStep();
	const wait = step.indexOf("tools/clusterio/ci-await-seeding.mjs");
	const verify = step.indexOf("tools/clusterio/ci-verify-seeded-boot.mjs");
	assert.ok(wait > 0, "the step does not run ci-await-seeding.mjs");
	assert.ok(verify > wait, "the seeded-boot check must run after the seeding wait, not before");
});

test("the step precedes the instance start-all it exists to order", () => {
	const workflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
	const bringUp = workflow.indexOf(`- name: ${STEP_NAME}`);
	const startAll = workflow.indexOf("instance start-all 2>&1");
	assert.ok(bringUp > 0 && startAll > 0, "ci.yml no longer drives `instance start-all`");
	assert.ok(bringUp < startAll, "waiting for the seed after driving start-all would not order anything");
});

test("only the two bring-up signatures retry — every other exit goes red immediately", () => {
	const step = bringUpStep();
	assert.match(step, new RegExp(`\\[ "\\$rc" -ne ${EXIT_TIMEOUT} \\] && \\[ "\\$rc" -ne ${EXIT_GENERATED_WORLD} \\]`),
		`the retry guard must name exactly ${EXIT_TIMEOUT} (seed timeout) and ${EXIT_GENERATED_WORLD} (generated world)`);
	const codes = [...step.matchAll(/-ne (\d+) \]/g)].map(m => Number(m[1])).filter(Boolean);
	assert.deepEqual([...new Set(codes)].sort((a, b) => a - b), [EXIT_TIMEOUT, EXIT_GENERATED_WORLD].sort((a, b) => a - b),
		"a third retryable exit code would widen the retry beyond the two bring-up signatures");
});

test("the retry rebuilds with down -v and never with a restart", () => {
	const step = bringUpStep();
	assert.match(step, /docker compose down -v/);
	assert.match(step, /docker compose up -d/);
	assert.doesNotMatch(step, /docker (compose )?restart/,
		"a restart re-seeds into the idempotency check and never re-uploads the save");
});

test("the retry is bounded at one and re-waits for the controller before re-checking", () => {
	const step = bringUpStep();
	assert.equal((step.match(/docker compose down -v/g) || []).length, 1, "more than one teardown means more than one retry");
	assert.equal((step.match(/await_seeded_cluster \|\| rc=\$\?/g) || []).length, 2, "the step must attempt exactly twice");
	const rebuild = step.indexOf("docker compose up -d");
	assert.ok(step.indexOf("wait_for_controller", rebuild) > rebuild,
		"the retry must wait for the controller to be healthy again before re-probing");
	assert.match(step, /the seed\/start race reproduced on the retry/,
		"a second failure must say it is not a flake");
});

test("nothing in the step touches the readiness gate or the suite", () => {
	const step = bringUpStep();
	assert.doesNotMatch(step, /run-integration-tests|cluster-readiness|continue-on-error/,
		"the retry must sit entirely before the gate, so it cannot re-run or soften it");
});
