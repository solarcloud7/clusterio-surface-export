import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cloneStatusLua, completedCloneIndex, waitForFixtureClone } from "./clone-fixture.mjs";

const complete = { success: true, index: 7, jobId: "import_51", active: false, identityMatched: true,
	status: "complete", complete: true };

test("a visible clone and even an early result cannot authorize fixture editing while its import runs", () => {
	assert.equal(completedCloneIndex({ success: true, index: 7, jobId: "import_51", active: true }), null);
	assert.equal(completedCloneIndex({ ...complete, active: true }), null);
});

test("successful completed imports, including clones without a transfer validation result, are ready", () => {
	assert.equal(completedCloneIndex(complete), 7);
	assert.equal(completedCloneIndex({ ...complete, validationSuccess: true }), 7);
});

test("a completed clone without a matching saved identity is unavailable", () => {
	assert.throws(() => completedCloneIndex({ ...complete, identityMatched: false }), /identity unavailable/);
});

test("absence of a job or retained result is not completion", () => {
	assert.equal(completedCloneIndex({ success: true, index: 7, active: false }), null);
	assert.equal(completedCloneIndex({ ...complete, jobId: undefined }), null);
	assert.equal(completedCloneIndex({ ...complete, complete: undefined }), null);
	assert.equal(completedCloneIndex({ ...complete, active: undefined }), null);
});

test("export, import, interruption, cleanup and validation failures stop fixture preparation", () => {
	for (const changed of [{ sourceError: "export refused" }, { error: "cleanup pending" },
		{ status: "failed" }, { status: "interrupted" }, { validationSuccess: false }]) {
		assert.throws(() => completedCloneIndex({ ...complete, ...changed }), /Clone failed/);
	}
	assert.throws(() => completedCloneIndex({ success: false }), /status unavailable/);
	assert.throws(() => completedCloneIndex({ ...complete, index: undefined }), /no valid platform/);
});

test("polling waits for actual completion rather than a fixed delay or platform visibility", async () => {
	let time = 0, reads = 0;
	const index = await waitForFixtureClone({
		read: () => ({ ...complete, active: ++reads < 4 }),
		timeoutMs: 1000, now: () => time, sleep: async ms => { time += ms; },
	});
	assert.equal(index, 7);
	assert.equal(reads, 4);
	assert.equal(time, 750);
});

test("missing or pruned clone results produce a bounded failure", async () => {
	let time = 0;
	await assert.rejects(waitForFixtureClone({
		read: () => ({ success: true, index: 7, active: false }),
		timeoutMs: 1000, now: () => time, sleep: async ms => { time += ms; },
	}), /did not complete within 1000 ms/);
	assert.equal(time, 1000);
});

test("completed export without an available clone import fails immediately", async () => {
	let sleeps = 0;
	await assert.rejects(waitForFixtureClone({
		read: () => ({ success: true, active: false, sourceStatus: "complete", sourceComplete: true }),
		timeoutMs: 1000, now: () => sleeps * 250, sleep: async () => { sleeps++; },
	}), /Clone import unavailable.*FAILED to queue import/);
	assert.equal(sleeps, 0);
});

test("generated Lua status executes failure, completion and ambiguity branches", t => {
	const lua = process.env.SE_TEST_LUA || "lua";
	const probe = spawnSync(lua, ["-v"], { encoding: "utf8" });
	if (probe.error?.code === "ENOENT" && !process.env.SE_TEST_LUA) return t.skip("Lua unavailable locally; CI also runs this case with Lua 5.2");
	assert.equal(probe.status, 0, probe.stderr || String(probe.error));
	const result = spawnSync(lua, [fileURLToPath(new URL("../lua/clone-fixture-status.lua", import.meta.url))], {
		input: cloneStatusLua("fixture", "export_1"), encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stdout + result.stderr);
	const query = cloneStatusLua("fixture", "export_1");
	for (const [guard, replacement] of [
		["source and source.clone_import_job_id", "next(ids)"],
		["platform.platform_index==identity.platform_index", "true"],
		["platform.surface_index==identity.surface_index", "true"],
		["platform.platform_uid==identity.platform_uid", "true"],
		["platform.force_name==identity.force_name", "true"],
	]) {
		assert.ok(query.includes(guard));
		const mutated = spawnSync(lua, [fileURLToPath(new URL("../lua/clone-fixture-status.lua", import.meta.url))], {
			input: query.replace(guard, replacement), encoding: "utf8",
		});
		assert.notEqual(mutated.status, 0, `Clone identity guard removal survived: ${guard}`);
	}
});

test("fixture identities cannot inject Lua", () => {
	assert.throws(() => cloneStatusLua("fixture'", "job-1"));
	assert.throws(() => cloneStatusLua("fixture", "job\n1"));
});
