import assert from "node:assert/strict";
import { test } from "node:test";
import { cloneStatusLua, completedCloneIndex, waitForFixtureClone } from "./clone-fixture.mjs";

const complete = { success: true, index: 7, jobId: "import_51", active: false,
	status: "complete", complete: true };

test("a visible clone and even an early result cannot authorize fixture editing while its import runs", () => {
	assert.equal(completedCloneIndex({ success: true, index: 7, jobId: "import_51", active: true }), null);
	assert.equal(completedCloneIndex({ ...complete, active: true }), null);
});

test("successful completed imports, including clones without a transfer validation result, are ready", () => {
	assert.equal(completedCloneIndex(complete), 7);
	assert.equal(completedCloneIndex({ ...complete, validationSuccess: true }), 7);
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

test("fixture identities cannot inject Lua", () => {
	assert.throws(() => cloneStatusLua("fixture'", "job-1"));
	assert.throws(() => cloneStatusLua("fixture", "job\n1"));
});
