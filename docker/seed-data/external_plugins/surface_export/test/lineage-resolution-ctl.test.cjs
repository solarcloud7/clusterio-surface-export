"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const originalLoad = Module._load;
const registered = [];
class FakeCommand {
	constructor(options) { this.definition = options.definition; this.handler = options.handler; registered.push(this); }
}
class FakeCommandTree {
	constructor(options) { this.name = options.name; this.children = []; }
	add(command) { this.children.push(command); }
}
Module._load = function(request, parent, isMain) {
	if (request === "@clusterio/lib") return { Command: FakeCommand, CommandTree: FakeCommandTree, escapeString: String };
	if (request === "@clusterio/ctl") return { BaseCtlPlugin: class {} };
	return originalLoad.call(this, request, parent, isMain);
};
const distNode = path.join(__dirname, "..", "dist", "node");
require(path.join(distNode, "control.js"));
const messages = require(path.join(distNode, "messages.js"));
Module._load = originalLoad;

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
