"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const pluginDir = path.join(__dirname, "..");
const distNode = path.join(pluginDir, "dist", "node");
const {
	SOURCE_TRANSFER_LOCK_STATES,
	normalizeSourceTransferLockState,
	parseSourceTransferLockStateJson,
} = require(path.join(distNode, "lib", "source-lock-state.js"));

function read(rel) {
	return fs.readFileSync(path.join(pluginDir, rel), "utf8");
}

test("source transfer lock state normalizer preserves every protocol state", () => {
	const expected = [
		"pre_commit",
		"committed",
		"source_gone_matching_transfer",
		"unknown/offline",
		"identity_mismatch",
		"unlocked",
		"source_missing",
	];

	assert.deepEqual(SOURCE_TRANSFER_LOCK_STATES, expected);
	for (const state of expected) {
		assert.equal(normalizeSourceTransferLockState({ state }).state, state, `state ${state} should round-trip`);
	}
	assert.equal(normalizeSourceTransferLockState(null).state, "unknown/offline");
	assert.equal(normalizeSourceTransferLockState({ state: "nonsense" }).state, "unknown/offline");
});

test("source transfer lock state parser handles Lua JSON and failures", () => {
	assert.deepEqual(parseSourceTransferLockStateJson('{"state":"pre_commit","transferId":"t1"}'), {
		state: "pre_commit",
		transferId: "t1",
		error: null,
	});
	assert.equal(parseSourceTransferLockStateJson('{"state":"identity_mismatch","error":"surface changed"}').state, "identity_mismatch");
	assert.equal(parseSourceTransferLockStateJson("not json").state, "unknown/offline");
	assert.equal(parseSourceTransferLockStateJson("").state, "unknown/offline");
});

test("a source retirement record turns an absent or unmatched lock into a deletion receipt", () => {
	const { applySourceRetirement } = require(path.join(distNode, "lib", "source-lock-state.js"));
	for (const state of ["unlocked", "source_missing", "identity_mismatch"]) {
		const result = applySourceRetirement({ state, transferId: "t1", error: null }, true);
		assert.equal(result.state, "source_gone_matching_transfer", state);
		assert.match(String(result.error), new RegExp(`retirement journal.*${state}`));
	}
	for (const state of ["pre_commit", "committed", "source_gone_matching_transfer", "unknown/offline"]) {
		assert.equal(applySourceRetirement({ state, transferId: "t1", error: null }, true).state, state, `${state} stands on its own`);
	}
	assert.equal(applySourceRetirement({ state: "source_missing", transferId: "t1", error: null }, false).state, "source_missing", "no retirement, no override");
	const instance = read("instance.ts");
	assert.match(instance, /applySourceRetirement\(state, retired\)/, "the instance must reconcile the Lua answer with its retirement journal");
});

test("GetSourceTransferLockStateRequest is wired through the message and instance layers", () => {
	const messages = read("messages.ts");
	const index = read("index.ts");
	const instance = read("instance.ts");
	const luaInterface = read(path.join("lib", "lua-interface.ts"));

	assert.match(messages, /class\s+GetSourceTransferLockStateRequest/, "message class must exist");
	assert.match(messages, /state:\s*\{\s*enum:\s*SOURCE_TRANSFER_LOCK_STATES/, "response schema must enumerate the five states");
	assert.match(index, /messages\.GetSourceTransferLockStateRequest/, "plugin manifest must register the message");
	assert.match(instance, /handleGetSourceTransferLockState/, "instance plugin must handle source state requests");
	assert.match(luaInterface, /getSourceTransferLockState/, "LuaInterface must expose the query remote");
});