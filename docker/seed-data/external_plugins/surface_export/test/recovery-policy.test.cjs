"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function(request, parent, main) {
	if (request === "@clusterio/lib") return {escapeString: String, wait: async () => {}};
	if (request === "@clusterio/host") return {BaseInstancePlugin: class {}};
	return originalLoad.call(this, request, parent, main);
};
const {InstancePlugin} = require("../dist/node/instance.js");
const messages = require("../dist/node/messages.js");
const {protectedSourceIndexes} = require("../dist/node/shared/recovery.js");

test("pending source ownership survives a checkpoint without a Lua retirement record", () => {
	assert.deepEqual(protectedSourceIndexes(1,[{sourceInstanceId:1,sourcePlatformIndex:3}],[]),[3]);
	assert.deepEqual(protectedSourceIndexes(1,[],[
		{sourceInstanceId:1,platformIndex:4,status:"transferring"},
		{sourceInstanceId:1,platformIndex:5,status:"completed"},
		{sourceInstanceId:2,platformIndex:6,status:"transferring"}]),[4]);
	assert.deepEqual(protectedSourceIndexes(1,[{sourceInstanceId:1}],[]),[-1]);
});
function harness() {
	const plugin = Object.create(InstancePlugin.prototype), calls = [];
	plugin.timingEpoch = "boot";
	plugin.logger = {warn() {}, info() {}};
	plugin.retirementJournal = {snapshot: () => ({id: "journal", retirements: [{platformUid: "old", exportId: "job"}]})};
	plugin.instance = {id: 1, sendTo: async (_target, request) => {
		calls.push(`controller:${request.action}`); return {mode: "save_game", allowAdoption: true};
	}};
	plugin.sourceRecoveryCall = async (action, ...args) => {
		calls.push(`lua:${action}`);
		if (action === "begin") {assert.deepEqual(args, ["boot", "journal", true, "save_game", true]);return {platforms: [{platformIndex: 3, platformUid: "old"}]};}
		if (action === "reconcile") {assert.deepEqual(args, [3,"old","job",false]);return {notice: {status: "accepted"}};}
		return {success: true};
	};
	plugin.handlePlatformStateChanged = async () => calls.push("broadcast");
	return {plugin,calls};
}
test("startup obtains policy before Lua reconciliation and reports applied mode after both finish acknowledgements", async () => {
	const {plugin,calls} = harness();await plugin.reconcileSourceRetirements("boot");
	assert.deepEqual(calls,["controller:begin","lua:begin","lua:reconcile","lua:finish","controller:finish","broadcast"]);
	assert.equal(plugin.recoveryStatus.mode,"save_game");assert.equal(plugin.recoveryStatus.state,"ready");
	assert.equal(plugin.recoveryStatus.notices[0].status,"accepted");
});
test("unavailable controller or local journal never authorizes Lua reconciliation", async () => {
	for (const journalFailure of [false,true]) {
		const {plugin,calls} = harness();
		plugin.instance.sendTo = async () => {calls.push("controller:unavailable");throw Error("controller unavailable");};
		if (journalFailure) plugin.retirementLoadError = "journal unavailable";
		await assert.rejects(plugin.reconcileSourceRetirements("boot"),/unavailable/);
		assert.ok(calls.every(call => !call.startsWith("lua:")));
		assert.equal(plugin.recoveryStatus.mode,undefined,"unverified mode claimed as applied");
	}
});
test("a delayed policy from an earlier startup cannot reconcile a newer running world", async () => {
	const {plugin,calls} = harness();let reply;
	plugin.instance.sendTo = () => new Promise(resolve => {reply = resolve;});
	const pending = plugin.reconcileSourceRetirements("boot");plugin.timingEpoch = "new-boot";
	reply({mode: "save_game", allowAdoption: true});
	await assert.rejects(pending,/stopped or replaced/);assert.deepEqual(calls,[]);
});

test("a policy refused by the loaded save is not reported as applied", async () => {
	const {plugin} = harness();
	plugin.sourceRecoveryCall = async () => {throw Error("Recovery journal differs from this save");};
	await assert.rejects(plugin.reconcileSourceRetirements("boot"),/journal differs/);
	assert.equal(plugin.recoveryStatus.mode,undefined);
});
test("snapshot retrieval and import keep their existing control permission boundaries", () => {
	assert.equal(messages.GetStoredExportRequest.permission,messages.PERMISSIONS.LIST_EXPORTS);
	assert.equal(messages.ImportUploadedExportRequest.permission,messages.PERMISSIONS.TRANSFER_EXPORTS);
	assert.equal(messages.RecoveryPolicyRequest.src,"instance");
	const input={targetInstanceId: 2,exportData: {},restoreExportId: "1:old",restoreRequestId: "a"};
	const request=messages.ImportUploadedExportRequest.fromJSON(input);
	assert.equal(request.toJSON().restoreRequestId,input.restoreRequestId);
});

test("source unlock uses canonical identity without accepting foreign or empty jobs", async () => {
	const {plugin} = harness();
	const calls = [];
	plugin.lua.unlockPlatform = async (...args) => { calls.push(args); return "SUCCESS"; };
	for (const [operationId, expected] of [
		["1:job:attempt", "job:attempt"], ["11:job", undefined],
		["1:", undefined], ["bad:job", undefined], [undefined, undefined],
	]) {
		assert.equal((await plugin.handleUnlockSourcePlatformMeasured({platformIndex: 3, operationId})).success, true);
		assert.deepEqual(calls.pop(), [3, undefined, expected]);
	}
});
