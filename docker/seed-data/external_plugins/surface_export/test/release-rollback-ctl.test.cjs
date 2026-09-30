"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
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

test("release-rollback sends only the transfer ID under the recovery permission and fails loudly on refusal", async () => {
	const command = find("release-rollback");
	assert.ok(command, "release-rollback command missing");
	assert.match(command.definition[0], /^release-rollback <transferId>$/);
	assert.match(command.definition[1], /Asserts that an administrator verified/, "the command must state what the operator asserts");
	assert.match(command.definition[1], /Refused while the source still reports this transfer's lock/, "the command must state its refusals");
	assert.equal(messages.ReleaseTransferRollbackRequest.permission, messages.PERMISSIONS.RECOVERY_RESOLVE);
	assert.equal(messages.ReleaseTransferRollbackRequest.src, "control");
	assert.equal(messages.ReleaseTransferRollbackRequest.dst, "controller");
	const transferId = "1:225_belt-roundtrip";
	const { sent, printed } = await invoke(command, { transferId },
		{ success: true, transferId, outcome: "released", status: "failed", sourceState: "unlocked", operator: "admin" });
	assert.equal(sent.length, 1);
	assert.ok(sent[0].message instanceof messages.ReleaseTransferRollbackRequest);
	assert.equal(sent[0].target, "controller");
	assert.deepEqual(sent[0].message.toJSON(), { transferId, acknowledgeContradiction: false }, "the ctl must send exactly the given transfer ID without acknowledging anything by default");
	assert.equal(JSON.parse(printed[0]).outcome, "released");
	const acknowledged = await invoke(command, { transferId, acknowledgeContradiction: true },
		{ success: true, transferId, outcome: "released", status: "cleanup_failed", sourceState: "source_gone_matching_transfer", contradiction: "source_gone_matching_transfer", acknowledged: true });
	assert.deepEqual(acknowledged.sent[0].message.toJSON(), { transferId, acknowledgeContradiction: true }, "the acknowledgement travels only when the operator gives it");
	assert.equal(JSON.parse(acknowledged.printed[0]).acknowledged, true);
	const idle = await invoke(command, { transferId }, { success: true, transferId, outcome: "nothing_pending", status: "failed" });
	assert.equal(JSON.parse(idle.printed[0]).outcome, "nothing_pending", "a retry after a lost reply reports that nothing is pending");
	await assert.rejects(invoke(command, { transferId },
		{ success: false, transferId, outcome: "refused", error: "The source still holds this transfer's lock" }), /still holds/);
});

test("the plugin manifest registers the release request and the ctl wrapper treats it as a write", () => {
	const index = fs.readFileSync(path.join(__dirname, "..", "index.ts"), "utf8");
	assert.match(index, /messages\.ReleaseTransferRollbackRequest/, "plugin manifest must register the message");
	const wrapperPath = path.join(__dirname, "..", "..", "..", "..", "..", "tools", "clusterio", "ctl.mjs");
	if (!fs.existsSync(wrapperPath)) return;
	assert.doesNotMatch(fs.readFileSync(wrapperPath, "utf8"), /"release-rollback"/, "release-rollback mutates controller state and must not be in the read-only list");
});
