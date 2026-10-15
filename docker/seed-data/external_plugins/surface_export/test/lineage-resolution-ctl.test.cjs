"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { registeredCommands } = require("./ctl-harness.cjs");
const distNode = path.join(__dirname, "..", "dist", "node");
const messages = require(path.join(distNode, "messages.js"));
const registered = registeredCommands();

const find = name => registered.find(command => String(command.definition[0]).startsWith(name));

async function invoke(command, args, reply) {
	const sent = [], printed = [];
	const log = console.log;
	console.log = line => printed.push(line);
	try { await command.handler(args, { sendTo: async (target, message) => { sent.push({ target, message }); return reply; } }); }
	finally { console.log = log; }
	return { sent, printed };
}

test("conflicts lists all or one instance through the controller", async () => {
	const command = find("conflicts");
	assert.match(command.definition[0], /^conflicts \[instanceId\]$/);
	const listing = { conflicts: [], unavailable: [], resolutions: [] };
	let { sent, printed } = await invoke(command, {}, listing);
	assert.ok(sent[0].message instanceof messages.ListLineageConflictsRequest);
	assert.equal(sent[0].target, "controller");
	assert.equal(sent[0].message.instanceId, null);
	assert.deepEqual(JSON.parse(printed[0]), listing);
	({ sent } = await invoke(command, { instanceId: 7 }, listing));
	assert.equal(sent[0].message.instanceId, 7);
});

test("resolve-platform sends one resolution with the caller's request ID and fails loudly on refusal", async () => {
	const command = find("resolve-platform");
	assert.match(command.definition[0], /^resolve-platform <instanceId> <platformIndex> <platformUid> <action> <requestId>$/);
	const args = { instanceId: 1, platformIndex: 3, platformUid: "boot:15", action: "keep_other", requestId: "11111111-2222-4333-8444-555555555555" };
	const { sent, printed } = await invoke(command, args, { success: true, requestId: args.requestId, status: "completed" });
	assert.ok(sent[0].message instanceof messages.ResolvePlatformLineageRequest);
	assert.deepEqual(sent[0].message.toJSON(), args, "the ctl invented a request ID or changed the action");
	assert.equal(JSON.parse(printed[0]).status, "completed");
	await assert.rejects(invoke(command, args, { success: false, error: "Action adopt is not available" }), /not available/);
});

test("abandon-resolution sends the request ID and fails loudly unless the resolution ended", async () => {
	const command = find("abandon-resolution");
	assert.match(command.definition[0], /^abandon-resolution <requestId>$/);
	assert.equal(messages.AbandonPlatformResolutionRequest.permission, messages.PERMISSIONS.RECOVERY_RESOLVE);
	const requestId = "11111111-2222-4333-8444-555555555555";
	const { sent, printed } = await invoke(command, { requestId }, { success: false, requestId, status: "failed", error: "Abandoned by an administrator" });
	assert.ok(sent[0].message instanceof messages.AbandonPlatformResolutionRequest);
	assert.deepEqual(sent[0].message.toJSON(), { requestId });
	assert.equal(JSON.parse(printed[0]).status, "failed");
	const finished = await invoke(command, { requestId }, { success: true, requestId, status: "completed", step: "completed" });
	assert.equal(JSON.parse(finished.printed[0]).status, "completed", "an abandon that finished a committed deletion was reported as an error");
	await assert.rejects(invoke(command, { requestId }, { success: false, requestId, status: "in_progress", step: "deleted",
		error: "This resolution has already deleted or committed a copy" }), /already deleted or committed/);
});
