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
	plugin.lua = {
		uploads: {initialize: async () => calls.push("uploads:initialize")},
		configurePlanetPolicy: async (...args) => {
			assert.deepEqual(args, [[], "nauvis", "Instance one", "boot"]);
			calls.push("planets:configure");
		},
	};
	plugin.logger = {warn() {}, info() {}};
	plugin.retirementJournal = {snapshot: () => ({id: "journal", retirements: [{platformUid: "old:7", exportId: "job", surfaceIndex: 9, platformIndex: 3, forceName: "player"}]})};
	const classified = [];
	plugin.instance = {id: 1, config: {get: key => key === "instance.name" ? "Instance one" : undefined}, sendTo: async (_target, request) => {
		if (request instanceof messages.LineageClassifyRequest) {
			calls.push("controller:classify"); classified.push(request);
			return {verdicts: request.platforms.map(platform => ({platformIndex: platform.platformIndex, verdict: "rollback_other", adopt: true, hints: {}}))};
		}
		calls.push(`controller:${request.action}`); return {mode: "save_game", allowAdoption: true};
	}};
	plugin.sourceRecoveryCall = async (action, ...args) => {
		calls.push(`lua:${action}`);
		if (action === "begin") {assert.deepEqual(args, ["boot", "journal", true, "save_game", true]);return {platforms: [{platformIndex: 3, platformUid: "old:7",
			hadIdentity: true, hubUnitNumber: 7, surfaceIndex: 9, lockKind: "startup", platformName: "ship", forceName: "player"}]};}
		if (action === "reconcile") {
			assert.deepEqual(args.slice(0, 4), [3,"old:7","job",false]);
			assert.equal(JSON.parse(args[4]).verdict, "rollback_other");
			return {notice: {status: "accepted"}};
		}
		return {success: true, quarantined: 0};
	};
	plugin.handlePlatformStateChanged = async () => calls.push("broadcast");
	return {plugin,calls,classified};
}
test("startup obtains policy before Lua reconciliation and reports applied mode after both finish acknowledgements", async () => {
	const {plugin,calls} = harness();await plugin.reconcileSourceRetirements("boot");
	assert.deepEqual(calls,["controller:begin","lua:begin","controller:classify","lua:reconcile","uploads:initialize","planets:configure","lua:finish","controller:finish","broadcast"]);
	assert.equal(plugin.recoveryStatus.mode,"save_game");assert.equal(plugin.recoveryStatus.state,"ready");
	assert.equal(plugin.recoveryStatus.notices[0].status,"accepted");
});

test("refused planet configuration keeps startup recovery closed", async () => {
	const {plugin, calls} = harness();
	plugin.lua.configurePlanetPolicy = async () => { throw new Error("Default planet is disabled"); };
	await assert.rejects(plugin.reconcileSourceRetirements("boot"), /Default planet/);
	assert.ok(!calls.includes("lua:finish"));
	assert.ok(!calls.includes("controller:finish"));
	assert.notEqual(plugin.recoveryStatus.state, "ready");
});

test("disabled planets are parsed from the comma-separated instance setting", async () => {
	const {plugin, calls} = harness();
	const settings = {"instance.name": "Instance one", "surface_export.disabled_planets": " nauvis, gleba ,", "surface_export.default_planet": "fulgora"};
	plugin.instance.config.get = key => settings[key];
	plugin.lua.configurePlanetPolicy = async (...args) => {
		assert.deepEqual(args, [["nauvis", "gleba"], "fulgora", "Instance one", "boot"]);
		calls.push("planets:configure");
	};
	await plugin.reconcileSourceRetirements("boot");
	assert.ok(calls.includes("planets:configure"));
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
	plugin.lua = {unlockPlatform: async (...args) => { calls.push(args); return "SUCCESS"; }};
	for (const [operationId, expected] of [
		["1:job:attempt", "job:attempt"], ["11:job", undefined],
		["1:", undefined], ["bad:job", undefined], [undefined, undefined],
	]) {
		assert.equal((await plugin.handleUnlockSourcePlatformMeasured({platformIndex: 3, operationId})).success, Boolean(expected));
		if (expected) assert.deepEqual(calls.pop(), [3, undefined, expected]);
		assert.equal(calls.length, 0, "invalid ownership must not reach Lua");
	}
});

test("Dev One: a journal with records quarantines only the hub-matched legacy platform and the instance becomes ready", async () => {
	const {classifyPlatform} = require("../dist/node/lib/lineage-classifier.js");
	const {plugin, calls, classified} = harness();
	plugin.retirementJournal = {snapshot: () => ({id: "journal", retirements: [
		{platformUid: "retired-boot:40", exportId: "job-a", surfaceIndex: 14, platformIndex: 4, forceName: "player"},
		{platformUid: "retired-boot:77", exportId: "job-b", surfaceIndex: 30, platformIndex: 9, forceName: "player", hubUnitNumber: 77}]})};
	plugin.instance.sendTo = async (_target, request) => {
		if (request instanceof messages.LineageClassifyRequest) {
			calls.push("controller:classify"); classified.push(request);
			return {verdicts: request.platforms.map(platform => classifyPlatform(platform, {inTransit: false, historyMatch: false, duplicateLocal: false},
				undefined, undefined, {instanceId: 1, epoch: "boot", mode: "plugin_history", allowAdoption: false}))};
		}
		calls.push(`controller:${request.action}`); return {mode: "plugin_history", allowAdoption: false, protectedSourceIndexes: []};
	};
	const reconciled = new Map();
	plugin.sourceRecoveryCall = async (action, ...args) => {
		calls.push(`lua:${action}`);
		if (action === "begin") return {platforms: [
			{platformIndex: 4, platformUid: "boot:40", hadIdentity: false, hubUnitNumber: 40, surfaceIndex: 14, lockKind: "startup"},
			{platformIndex: 5, platformUid: "boot:50", hadIdentity: false, hubUnitNumber: 50, surfaceIndex: 15, lockKind: "startup"},
			{platformIndex: 6, platformUid: "boot:77", hadIdentity: true, hubUnitNumber: 77, surfaceIndex: 30, lockKind: "startup"}]};
		if (action === "reconcile") {
			const verdict = JSON.parse(args[4]);
			reconciled.set(args[0], verdict);
			return verdict.verdict === "normal" ? {success: true} : {success: true, quarantined: true,
				notice: {platformIndex: args[0], platformUid: args[1], status: "quarantined", reason: verdict.verdict}};
		}
		return {success: true, quarantined: 1};
	};
	await plugin.reconcileSourceRetirements("boot");
	const sent = classified[0].platforms;
	assert.deepEqual(sent.map(platform => [platform.platformIndex, platform.journalHubMatch, platform.hadIdentity, platform.journalUidMatch]),
		[[4, true, false, false], [5, false, false, false], [6, true, true, false]]);
	assert.equal(reconciled.get(4).verdict, "legacy_unclassified");
	assert.deepEqual([reconciled.get(5).verdict, reconciled.get(5).mint, reconciled.get(5).lineage], ["normal", true, "lineage:boot:50"]);
	assert.deepEqual([reconciled.get(6).verdict, reconciled.get(6).mint], ["normal", true], "an identified platform was held by a coincidental hub number");
	assert.equal(plugin.recoveryStatus.state, "ready");
	assert.equal(plugin.recoveryStatus.quarantined, 1);
	assert.deepEqual(plugin.recoveryStatus.notices.map(notice => [notice.platformIndex, notice.reason]), [[4, "legacy_unclassified"]]);
});

test("authority failures stay instance-level: an unindexed handoff, a lost classification or a missing verdict", async () => {
	for (const failure of ["unindexed", "lost", "missing"]) {
		const {plugin, calls} = harness();
		const send = plugin.instance.sendTo;
		plugin.instance.sendTo = async (target, request) => {
			if (failure === "unindexed" && !(request instanceof messages.LineageClassifyRequest)) {
				calls.push(`controller:${request.action}`); return {mode: "save_game", allowAdoption: false, protectedSourceIndexes: [-1]};
			}
			if (request instanceof messages.LineageClassifyRequest) {
				if (failure === "lost") throw new Error("Session Closed");
				if (failure === "missing") return {verdicts: []};
			}
			return send(target, request);
		};
		const retire = plugin.sourceRecoveryCall;
		plugin.sourceRecoveryCall = async (action, ...args) => {
			if (action === "begin") { calls.push("lua:begin"); return {platforms: [{platformIndex: 8, platformUid: "fresh:8", hadIdentity: true,
				hubUnitNumber: 8, surfaceIndex: 18, lockKind: "startup"}]}; }
			return retire(action, ...args);
		};
		await assert.rejects(plugin.reconcileSourceRetirements("boot"), failure === "unindexed" ? /no source platform index/
			: failure === "lost" ? /Session Closed/ : /no lineage verdict/);
		assert.ok(!calls.includes("lua:reconcile"), `${failure} reached Lua reconciliation`);
		assert.ok(!calls.includes("lua:finish"));
		assert.notEqual(plugin.recoveryStatus.state, "ready");
	}
});

test("presence is answered only by a ready instance", async () => {
	const {plugin} = harness();
	plugin.recoveryStatus = {state: "reconciling", epoch: "boot", notices: []};
	let asked = 0;
	plugin.sourceRecoveryCall = async () => { asked++; return {success: true, lineages: []}; };
	await assert.rejects(plugin.handleLineagePresenceRequest(new messages.LineagePresenceRequest({lineages: ["lineage:e:1"]})), /not ready/);
	assert.equal(asked, 0);
	plugin.recoveryStatus.state = "ready";
	plugin.sourceRecoveryCall = async (action, json) => { asked++; assert.equal(action, "presence");
		return {success: true, lineages: JSON.parse(json).map(lineage => ({lineage, present: true}))}; };
	const reply = await plugin.handleLineagePresenceRequest(new messages.LineagePresenceRequest({lineages: ["lineage:e:1"]}));
	assert.deepEqual(reply.lineages, [{lineage: "lineage:e:1", present: true}]);
});
