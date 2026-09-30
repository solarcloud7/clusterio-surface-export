"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const distNode = path.join(__dirname, "..", "dist", "node");
const { TransferOrchestrator } = require(path.join(distNode, "lib", "transfer-orchestrator.js"));
const { isSessionLostError } = require(path.join(distNode, "helpers.js"));
const { TransactionLogger } = require(path.join(distNode, "lib", "transaction-logger.js"));
const messages = require(path.join(distNode, "messages.js"));
const { LineageRegistry, withLineage, mirrorHold, presenceOf } = require("./lineage-harness.cjs");
const { normalizeSectionExport, prepareSectionImport } = require(path.join(distNode, "lib", "section-codec.js"));
const { deflateSync } = require("node:zlib");

function sessionLost(message = "Session Closed") {
	return Object.assign(new Error(message), { code: "SessionLost" });
}

function makeHarness(importSendResult, sourceSendResult = () => ({ success: true })) {
	const noop = () => {};
	const activeTransfers = new Map();
	const calls = { events: [], unlockRouteTaken: 0, importSends: 0, openPhases: new Set() };

	const plugin = {
		logger: { error: noop, warn: noop, info: noop },
		persistPendingTransfer: (intent) => { calls.pendingPersisted = intent; },
		persistPendingTransfers: async () => {},
		removePendingTransfer: (id) => { calls.pendingRemoved = id; },
		isInstanceOnline: (id) => (calls.offlineInstances ? !calls.offlineInstances.has(id) : true),
		autoPauseRefusal: async (id, role) => (calls.autoPaused?.has(id) ? `${role} instance-${id} has auto-pause on` : null),
		persistStorage: async () => { calls.persistStorageCalls = (calls.persistStorageCalls || 0) + 1; },
		lineageRegistry: new LineageRegistry(),
		lineagePresence: presenceOf((instanceId, lineage) => {
			calls.presenceChecks = [...(calls.presenceChecks || []), [instanceId, lineage]];
			return calls.presence?.(instanceId, lineage) ?? { state: "absent" };
		}),
		platformStorage: {
			get: () => ({
				exportData: withLineage({ platform: { force: "player" } }),
				exportMetrics: null,
				platformName: "test-platform",
				platformIndex: 3,
				instanceId: 1,
				size: 123,
			}),
			delete: noop,
		},
		platformTree: { resolvePlatformUid: async (_id, index, _force, uid) => uid || `fixture:${index}`, resolveInstanceName: (id) => `instance-${id}` },
		activeTransfers,
		recordTransferStarted: async () => { calls.startRows = (calls.startRows || 0) + 1; },
		txLogger: {
			...require("./timing-harness.cjs").makeTimingHarness(),
			logTransactionEvent: (_id, type) => { calls.events.push(type); },
			archiveRecycledTransferId() {},
			startPhase: (_id, name) => { calls.openPhases.add(name); },
			endPhase: (_id, name) => { calls.openPhases.delete(name); return 0; },
			persistTransactionLog: async () => {},
			buildPhaseSummary: () => ({}),
		},
		subscriptions: { emitTransferUpdate: noop, queueTreeBroadcast: noop },
		controller: {
			sendTo: async (_dst, msg) => {
				if (msg && msg.constructor && msg.constructor.name === "ImportPlatformRequest") {
					calls.importSends++;
					return importSendResult(msg);
				}
				return mirrorHold(activeTransfers, msg, sourceSendResult(msg));
			},
		},
	};

	const orch = new TransferOrchestrator(plugin, messages);
	orch.tryUnlockSource = async () => { calls.unlockRouteTaken++; return null; };
	return { orch, activeTransfers, calls, plugin };
}

function onlyTransfer(activeTransfers) {
	const all = [...activeTransfers.values()];
	assert.equal(all.length, 1, "exactly one transfer record expected");
	return all[0];
}

for (const [status, observedInstance, restored, settled, protectedSource] of [
	["queued", null, false, false, false],
	["preparing", 1, true, false, true],
	["in_progress", 1, true, false, true],
	["transporting", null, true, false, true],
	["awaiting_validation", 2, true, false, true],
	["awaiting_completion", 2, true, false, true],
	["completed", null, false, true, false],
	["failed", null, false, true, false],
	["error", null, false, true, false],
	["cleanup_failed", null, false, true, true],
	["unknown", null, false, false, true],
]) {
	test(`${status}: observation, admission and source protection have distinct boundaries`, async t => {
		const { hasUnresolvedOwnership, protectedSourceIndexes } = require("../dist/node/shared/recovery");
		const h = makeHarness(() => { throw Error("observation must not import"); });
		t.after(() => h.orch.stop());
		const operation = {transferId: "lifecycle:1", operationType: "transfer", status,
			sourceInstanceId: 1, targetInstanceId: 2, platformIndex: 3, forceName: "player"};
		h.activeTransfers.set(operation.transferId, operation);
		h.orch.observationDue.set(operation.transferId, 0);
		const polls = [];
		h.orch.observer.poll = async (instanceId, jobs) => {
			polls.push({instanceId, jobs});
			return {version: 1, epoch: "boot", jobs: []};
		};
		await h.orch.observeJobs();
		assert.deepEqual(polls.map(poll => poll.instanceId), observedInstance === null ? [] : [observedInstance]);
		assert.equal(operation.status, status);
		assert.equal(operation.completedAt, undefined);
		assert.equal(h.calls.importSends, 0);
		assert.equal(h.calls.unlockRouteTaken, 0);
		for (const timingPendingRecovery of [undefined, null, false, true]) {
			operation.timingPendingRecovery = timingPendingRecovery;
			const protectedNow = status !== "queued" && (protectedSource || Boolean(timingPendingRecovery));
			assert.equal(hasUnresolvedOwnership(1, [], [operation]), protectedNow);
			assert.equal(hasUnresolvedOwnership(2, [], [operation]), protectedNow);
			assert.equal(hasUnresolvedOwnership(9, [], [operation]), false);
			assert.deepEqual(protectedSourceIndexes(1, [], [operation]), protectedNow ? [3] : []);
			assert.deepEqual(protectedSourceIndexes(2, [], [operation]), []);
			assert.deepEqual(h.orch.requestQueue.hooks.busyInstances(),
				status !== "queued" && (!settled || timingPendingRecovery) ? [1, 2] : []);
		}
		h.activeTransfers.clear();
		h.plugin.persistedTransactionLogs = [{transferId: operation.transferId, transferInfo: {...operation}}];
		h.orch.restoreImportObservations();
		assert.equal(h.activeTransfers.has(operation.transferId), restored);
	});
}

test("retained snapshots cannot repeat a handoff after active history is lost", async t => {
	const h = makeHarness(() => ({success: true}));
	t.after(() => h.orch.stop());
	await h.orch.transferPlatform("1:retained", 2);
	h.activeTransfers.clear();
	const replay = await h.orch.transferPlatform("1:retained", 3);
	assert.equal(replay.success, false);
	assert.equal(replay.safeToUnlockSource, false);
	assert.equal(h.calls.importSends, 1);
});

test("destination-only startup recovery rejects an untouched export with source cleanup authority", async t => {
	const h = makeHarness(() => {throw Error("must not import during recovery");});
	t.after(() => h.orch.stop());
	h.plugin.recoveryReservations = new Map([[2, {}]]);
	const result = await h.orch.transferPlatform("1:not-sent", 2);
	assert.equal(result.success, false);
	assert.equal(result.safeToUnlockSource, true);
	assert.equal(h.calls.importSends, 0);
	h.plugin.pendingTransfers = new Map([["1:not-sent", {sourceInstanceId: 1, targetInstanceId: 2}]]);
	assert.equal((await h.orch.transferPlatform("1:not-sent", 2)).safeToUnlockSource, false);
});

test("import and validation failures expose the actual source rollback acknowledgement", async t => {
	const { TransactionLogger } = require(path.join(distNode, "lib", "transaction-logger.js"));
	const { shipPhaseFor } = require(path.join(distNode, "shared", "transfer-status.js"));
	for (const handler of ["import", "validation"]) {
		for (const error of [null, "source offline"]) {
			const h = makeHarness(() => { throw Error("must not replay import"); });
			t.after(() => h.orch.stop());
			delete h.orch.tryUnlockSource;
			let reply;
			h.orch.sendUnlockRequest = () => new Promise(resolve => { reply = resolve; });
			h.orch.broadcastTransferAbort = async () => {};
			const row = { transferId: "rollback:1", platformIndex: 3, platformName: "fixture", forceName: "player",
				sourceInstanceId: 1, targetInstanceId: 2, status: "awaiting_validation" };
			h.activeTransfers.set(row.transferId, row);
			h.plugin.transactionLogs = new Map();
			const recorded = [];
			h.plugin.txLogger.logTransactionEvent = (_id, type) => recorded.push({ type, outcome: row.sourceRollback });
			const result = handler === "import" ? h.orch.handleImportFailure(row.transferId, "rejected", 1)
				: h.orch.handleValidationFailure(row.transferId, row, { mismatchDetails: "rejected" });
			await new Promise(resolve => setImmediate(resolve));
			assert.equal(row.sourceRollback, "attempted");
			assert.equal(recorded.find(event => event.type === "rollback_attempt").outcome, "attempted");
			reply(error);
			await result;
			const expected = error ? "failed" : "succeeded";
			assert.equal(row.sourceRollback, expected);
			assert.equal(recorded.find(event => event.type === (error ? "rollback_failed" : "rollback_success")).outcome,
				expected);
			const view = new TransactionLogger(h.plugin).buildTransferInfo(row);
			assert.equal(view.sourceRollback, expected);
			assert.equal(view.sourceRestored, !error);
			assert.equal(shipPhaseFor(view).terminal, !error);
			assert.equal(shipPhaseFor(view).distance, error && handler === "validation" ? 0.5 : 0);
			assert.equal(h.calls.importSends, 0);
		}
	}
});

test("an unexpected source-unlock exception leaves failed rollback evidence", async t => {
	const h = makeHarness(() => {});
	t.after(() => h.orch.stop());
	delete h.orch.tryUnlockSource;
	h.orch.sendUnlockRequest = async () => { throw Error("unlock exception"); };
	const row = { sourceInstanceId: 1, platformIndex: 3 };
	await assert.rejects(h.orch.tryUnlockSource("rollback:throw", row), /unlock exception/);
	assert.equal(row.sourceRollback, "failed");
	assert.ok(!h.calls.events.includes("rollback_success"));
});

test("admitted queue work remains observable through repeated controller restarts", async t => {
	const fs = require("node:fs/promises"), os = require("node:os");
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "se-admitted-observation-"));
	t.after(() => fs.rm(dir, {recursive: true, force: true}));
	const journal = path.join(dir, "queue.json");
	const h = makeHarness(() => {throw Error("must not replay import");});
	t.after(() => h.orch.stop());
	h.plugin.persistedTransactionLogs = [];
	const operation = {transferId:"1:queued",operationType:"transfer",sourceInstanceId:1,targetInstanceId:2,
		platformIndex:3,platformUid:"selected-copy",platformName:"fixture",forceName:"player",status:"transporting",sourceExportId:"queued"};
	await fs.writeFile(journal, JSON.stringify([{id:"request:1",request:{},operation}]));
	await h.orch.requestQueue.init(journal);
	const restored = onlyTransfer(h.activeTransfers);
	assert.equal(restored.status,"awaiting_validation");assert.equal(restored.completedAt,undefined);
	assert.equal(restored.awaitingLateVerdict,true);assert.equal(h.calls.importSends,0);
	h.plugin.transactionLogs = new Map();
	h.plugin.persistedTransactionLogs = [{transferId:restored.transferId,transferInfo:JSON.parse(JSON.stringify(new TransactionLogger(h.plugin).buildTransferInfo(restored)))}];
	h.activeTransfers.clear();
	h.orch.restoreImportObservations();
	assert.equal(onlyTransfer(h.activeTransfers).status,"awaiting_validation");
	assert.equal(onlyTransfer(h.activeTransfers).sourceExportId,"queued");
	assert.equal(onlyTransfer(h.activeTransfers).platformUid,"selected-copy");
	assert.equal(h.calls.importSends,0);assert.equal(h.calls.unlockRouteTaken,0);
});

test("source export waiting ignores unrelated standalone uploads with no source instance", async () => {
	const h=makeHarness(()=>{throw Error("must not replay");});
	h.plugin.platformStorage=new Map();
	h.activeTransfers.set("upload:1",{operationType:"import",sourceInstanceId:-1,status:"completed"});
	h.activeTransfers.set("export:1",{operationType:"export",sourceInstanceId:1,sourceExportId:"source-job",status:"in_progress"});
	const stored={exportId:"1:source-job",instanceId:1,sourceExportId:"source-job"};
	h.orch.observeJobs=async()=>h.plugin.platformStorage.set(stored.exportId,stored);
	assert.equal(await h.orch.waitForStoredExport(stored.exportId),stored);
});

test("lost export reply is found after two restarts and source cleanup retries without importing", async t => {
	const fs = require("node:fs/promises"), os = require("node:os");
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "se-source-admission-"));
	t.after(() => fs.rm(dir, {recursive: true, force: true}));
	const file = path.join(dir, "queue.json"), id = "request:lost-export";
	const original = {id, request: {sourceInstanceId: 1, targetInstanceId: 2, sourcePlatformIndex: 3},
		operation: {transferId: id, operationType: "transfer", sourceInstanceId: 1, targetInstanceId: 2,
			platformIndex: 3, forceName: "player", platformName: "fixture", status: "preparing"}};
	await fs.writeFile(file, JSON.stringify({v: 2, handoffs: [], entries: [original]}));
	const create = async () => {
		const h = makeHarness(() => {throw Error("must not import");}); t.after(() => h.orch.stop());
		h.plugin.persistedTransactionLogs = []; h.plugin.platformStorage = new Map();
		await h.orch.requestQueue.init(file); h.orch.requestQueue.stop();
		h.orch.observationDue.set(id, 0);
		h.orch.observer.poll = async (instanceId, jobs) => {
			assert.equal(instanceId, 1); assert.ok(jobs[0].jobId === "lost-export" || jobs[0].operationId === id);
			return {version: 1, epoch: "source-epoch", jobs: [{jobId: "lost-export", operationId: id, state: "completed"}]};
		};
		return h;
	};
	const first = await create(); first.orch.stop();
	const second = await create(); assert.equal(second.activeTransfers.size, 1, "second restart lost unresolved queue entry");
	let unlocks = 0;
	delete second.orch.tryUnlockSource;
	second.orch.sendUnlockRequest = async (...args) => {assert.equal(args[4], "lost-export"); assert.equal(args[3], undefined, "a display placeholder is not lock identity"); unlocks++; return "source disconnected";};
	await second.orch.observeJobs();
	assert.equal(unlocks, 1); assert.equal(second.activeTransfers.get(id).status, "preparing");
	await second.orch.requestQueue.persist(); second.orch.stop();
	const third = await create(); delete third.orch.tryUnlockSource;
	third.orch.sendUnlockRequest = async (...args) => {assert.equal(args[4], "lost-export"); assert.equal(args[3], undefined, "a display placeholder is not lock identity"); unlocks++; return null;};
	await third.orch.observeJobs();
	assert.equal(unlocks, 2); assert.equal(third.activeTransfers.get(id).status, "failed");
	assert.equal(third.activeTransfers.get(id).timingPendingRecovery, false);
	assert.equal(third.calls.importSends, 0);
	assert.deepEqual(third.orch.requestQueue.handoffs.get("1:lost-export"), {destination: 2, cancelledBy: id});
});

test("failed cancellation persistence cannot unlock on a subsequent poll", async t => {
	const h = makeHarness(() => {throw Error("must not import");}); t.after(() => h.orch.stop());
	const row = {transferId: "request:cancel", operationType: "transfer", sourceInstanceId: 1, targetInstanceId: 2,
		platformIndex: 3, sourceExportId: "source", status: "preparing", timingPendingRecovery: true};
	h.activeTransfers.set(row.transferId, row); h.orch.interruptedSources.add(row.transferId);
	h.orch.requestQueue.persist = async () => {throw Error("disk full");};
	await assert.rejects(h.orch.reconcileInterruptedSource(row), /could not be persisted/);
	await h.orch.reconcileInterruptedSource(row);
	assert.equal(h.calls.unlockRouteTaken, 0); assert.equal(h.calls.importSends, 0);
	assert.equal(row.timingPendingRecovery, true);
});

test("completed Lua work can precede artifact delivery without failing or unlocking", async () => {
	const h=makeHarness(()=>{throw Error("must not replay");});
	h.plugin.platformStorage=new Map();
	const operation={operationType:"export",sourceInstanceId:1,sourceExportId:"source-job",status:"in_progress",
		jobObservation:{state:"completed"}};
	h.activeTransfers.set("export:1",operation);
	let reads=0;
	const stored={exportId:"1:source-job",instanceId:1,sourceExportId:"source-job"};
	h.orch.observeJobs=async()=>{if(++reads===2)h.plugin.platformStorage.set(stored.exportId,stored);};
	assert.equal(await h.orch.waitForStoredExport(stored.exportId),stored);
	assert.equal(h.calls.unlockRouteTaken,0);
});

test("completed source job recovers its retained artifact once without replaying Lua work", async () => {
	let reads = 0;
	const h = makeHarness(() => {throw Error("must not import from observation");}, message => {
		if (message.constructor.name === "ReadExportRequest") {
			reads++;
			assert.equal(message.exportId, "source-job");
			return {success: true, exportId: message.exportId, epoch: "runtime", exportData: {platform_name: "original name", platform: {force: "player"}}};
		}
		throw Error("unexpected request " + message.constructor.name);
	});
	h.plugin.platformStorage = new Map();
	h.plugin.handlePlatformExport = async event => h.plugin.platformStorage.set(`1:${event.exportId}`, event);
	const operation = {transferId: "export:1", operationType: "export", sourceInstanceId: 1, sourceExportId: "source-job",
		platformIndex: 3, platformName: "fixture", status: "in_progress"};
	h.activeTransfers.set(operation.transferId, operation);
	h.orch.observationDue.set(operation.transferId, 0);
	h.orch.observer.poll = async () => ({version: 1, epoch: "runtime", jobs: [{jobId: "source-job", state: "completed"}]});
	await h.orch.observeJobs();
	assert.equal(h.plugin.platformStorage.get("1:source-job")?.platformIndex, 3);
	assert.equal(h.plugin.platformStorage.get("1:source-job")?.platformName, "original name");
	await h.orch.observeJobs();
	assert.equal(reads, 1);
	assert.equal(h.calls.importSends, 0);
	assert.equal(h.calls.unlockRouteTaken, 0);
});

test("missing recovery payload remains unresolved and is not pulled on every poll", async () => {
	let reads = 0;
	const h = makeHarness(() => {throw Error("must not replay");}, () => {reads++; return {success: false, error: "cache missing"};});
	h.plugin.platformStorage = new Map();
	const operation = {transferId: "export:1", operationType: "export", sourceInstanceId: 1, sourceExportId: "source-job", status: "in_progress"};
	h.activeTransfers.set(operation.transferId, operation);
	h.orch.observationDue.set(operation.transferId, 0);
	h.orch.observer.poll = async () => ({version: 1, epoch: "runtime", jobs: [{jobId: "source-job", state: "completed"}]});
	await h.orch.observeJobs();
	await h.orch.observeJobs();
	assert.equal(reads, 1);
	assert.match(operation.jobObservation.reason, /cache missing/);
	assert.equal(operation.status, "in_progress");
	assert.equal(operation.completedAt, undefined);
	assert.equal(h.calls.unlockRouteTaken, 0);
});

test("concurrent artifact recovery rejects foreign and late replies without settling ownership", async () => {
	for (const variant of ["foreign-job", "foreign-epoch", "settled", "replaced", "stopped"]) {
		let release, reads = 0;
		const pending = new Promise(resolve => {release = resolve;});
		const h = makeHarness(() => {throw Error("must not replay");}, () => {reads++; return pending;});
		h.plugin.platformStorage = new Map();
		h.plugin.handlePlatformExport = async () => {throw Error("must not store a stale artifact");};
		const operation = {transferId: "export:1", operationType: "export", sourceInstanceId: 1,
			sourceExportId: "source-job", status: "in_progress"};
		h.activeTransfers.set(operation.transferId, operation);
		h.orch.observationDue.set(operation.transferId, 0);
		h.orch.observer.poll = async () => ({version: 1, epoch: "runtime", jobs: [{jobId: "source-job", state: "completed"}]});
		const first = h.orch.observeJobs();
		await Promise.resolve();
		await h.orch.observeJobs();
		assert.equal(reads, 1, variant);
		if (variant === "settled") operation.status = "failed";
		if (variant === "replaced") h.activeTransfers.set(operation.transferId, {...operation});
		if (variant === "stopped") h.orch.stop();
		release({success: true, exportId: variant === "foreign-job" ? "other-job" : "source-job",
			epoch: variant === "foreign-epoch" ? "other-runtime" : "runtime", exportData: {entities: []}});
		await first;
		assert.equal(h.plugin.platformStorage.size, 0);
		assert.equal(h.calls.importSends, 0);
		assert.equal(h.calls.unlockRouteTaken, 0);
	}
});

test("superseded source observations and offline sources cannot supply the winning artifact", async () => {
	for (const variant of ["new-read", "new-observation", "offline"]) {
		const replies = [];
		const h = makeHarness(() => {throw Error("must not replay");}, () => new Promise(resolve => replies.push(resolve)));
		h.plugin.platformStorage = new Map();
		h.plugin.handlePlatformExport = async event => {
			if (!h.plugin.platformStorage.has("1:source-job")) h.plugin.platformStorage.set("1:source-job", event);
		};
		const operation = {transferId: "export:1", operationType: "export", sourceInstanceId: 1,
			sourceExportId: "source-job", status: "in_progress", jobObservation: {state: "completed", epoch: "old"}};
		h.activeTransfers.set(operation.transferId, operation);
		const first = h.orch.recoverExportArtifact(operation, "old");
		await new Promise(setImmediate);
		if (variant === "offline") h.calls.offlineInstances = new Set([1]);
		else operation.jobObservation = {state: "queued", epoch: "new"};
		const second = variant === "new-read" ? h.orch.recoverExportArtifact(operation, "new") : undefined;
		await new Promise(setImmediate);
		replies[0]({success: true, exportId: "source-job", epoch: "old", exportData: {origin: "old"}});
		await first;
		assert.equal(h.plugin.platformStorage.size, 0, variant);
		if (second) {
			replies[1]({success: true, exportId: "source-job", epoch: "new", exportData: {origin: "new"}});
			await second;
			assert.equal(h.plugin.platformStorage.get("1:source-job").exportData.origin, "new");
		}
		assert.equal(h.calls.importSends, 0);
		assert.equal(h.calls.unlockRouteTaken, 0);
	}
});

test("a rejected old artifact read cannot publish a superseded transfer or epoch", async () => {
	for (const variant of ["replaced", "epoch"]) {
		let reject;
		const pending = new Promise((_resolve, fail) => {reject = fail;});
		const h = makeHarness(() => {throw Error("must not replay");}, () => pending);
		h.plugin.platformStorage = new Map();
		const updates = [];
		h.orch.updateTransfer = transfer => updates.push(transfer);
		const operation = {transferId: "export:1", operationType: "export", sourceInstanceId: 1,
			sourceExportId: "source-job", status: "in_progress", jobObservation: {state: "completed", epoch: "old"}};
		h.activeTransfers.set(operation.transferId, operation);
		const read = h.orch.recoverExportArtifact(operation, "old");
		await new Promise(setImmediate);
		if (variant === "replaced") h.activeTransfers.set(operation.transferId, {...operation, status: "completed"});
		else operation.jobObservation = {state: "queued", epoch: "new"};
		reject(Error("old runtime stopped"));
		await read;
		assert.equal(updates.length, 0, variant);
		assert.equal(operation.jobObservation.reason, undefined, variant);
	}
});

test("explicit source delivery failure ends artifact waiting without an import", async () => {
	const h=makeHarness(()=>{throw Error("must not replay");});
	h.plugin.platformStorage=new Map();
	h.activeTransfers.set("export:1",{operationType:"export",sourceInstanceId:1,sourceExportId:"source-job",status:"in_progress",
		jobObservation:{state:"failed",reason:"Export notification failed: injected"}});
	h.orch.observeJobs=async()=>{};
	await assert.rejects(h.orch.waitForStoredExport("1:source-job"),/Export notification failed/);
	assert.equal(h.calls.importSends,0);
});

test("known offline instances remain visible without sending status requests", async () => {
	let sends=0;
	const h=makeHarness(()=>{throw Error("must not replay");},()=>{sends++;throw Error("must not poll offline");});
	h.calls.offlineInstances=new Set([2]);
	h.activeTransfers.set("op",{transferId:"op",operationType:"import",targetInstanceId:2,status:"awaiting_completion"});
	h.orch.observationDue.set("op",0);
	await h.orch.observeJobs();
	assert.equal(sends,0);
	assert.match(h.activeTransfers.get("op").jobObservation.reason,/offline/);
	assert.equal(h.activeTransfers.get("op").status,"awaiting_completion");
});

test("retention cannot evict unresolved jobs or their retry guards", () => {
	const h = makeHarness(() => {throw Error("must not replay");});
	const protectedRecords = [
		{status:"awaiting_validation"}, {status:"awaiting_completion"}, {status:"cleanup_failed"},
		{status:"failed",validationResult:{destinationPreserved:true}},
		{status:"error",timingPendingRecovery:true}, {status:"completed",pending:true},
	];
	h.plugin.pendingTransfers = new Map();
	protectedRecords.forEach((record,index) => {
		const transferId=`protected:${index}`;
		h.activeTransfers.set(transferId,{...record,transferId,startedAt:1});
		if(record.pending) h.plugin.pendingTransfers.set(transferId,{});
	});
	for(let index=0;index<105;index++) h.activeTransfers.set(`done:${index}`,{status:"completed",startedAt:100+index});
	h.orch.pruneOldTransfers();
	protectedRecords.forEach((_,index) => assert.ok(h.activeTransfers.has(`protected:${index}`)));
	assert.equal([...h.activeTransfers.keys()].filter(id=>id.startsWith("done:")).length,100);
});

test("a recovered standalone export completes when its exact artifact is already stored", async () => {
	const h = makeHarness(() => {throw Error("must not replay");});
	h.plugin.persistedTransactionLogs = [{transferId:"export:restarted",transferInfo:{
		operationType:"export",status:"in_progress",sourceInstanceId:1,targetInstanceId:-1,
		sourceExportId:"source-job",exportId:"1:source-job",platformName:"fixture",platformIndex:3,
	}}];
	h.plugin.platformStorage = new Map([["1:source-job", {exportId:"1:source-job",sourceExportId:"source-job",
		instanceId:1,platformName:"fixture",size:123,exportData:{}}]]);
	h.orch.restoreImportObservations();
	await h.orch.observeJobs();
	const operation = onlyTransfer(h.activeTransfers);
	assert.equal(operation.status,"completed");
	assert.equal(operation.observedDurationMs??null,null,"cannot reconstruct a monotonic duration across restart");
	assert.equal(h.calls.importSends,0);assert.equal(h.calls.unlockRouteTaken,0);
});

test("recovered export needs its stored artifact or explicit source failure, not a completed job alone", async () => {
	const h = makeHarness(() => {throw Error("must not replay");});
	h.plugin.persistedTransactionLogs = [{transferId:"export:restarted",transferInfo:{
		operationType:"export",status:"in_progress",sourceInstanceId:1,targetInstanceId:-1,
		sourceExportId:"source-job",exportId:"1:source-job",platformName:"fixture",platformIndex:3,
	}}];
	h.plugin.platformStorage = new Map();
	h.orch.restoreImportObservations();
	h.orch.observationDue.set("export:restarted",0);
	let state="completed";
	h.orch.observer.poll=async()=>({version:1,epoch:"runtime",jobs:[{jobId:"source-job",state,error:"export failed"}]});
	await h.orch.observeJobs();
	const operation=onlyTransfer(h.activeTransfers);
	assert.equal(operation.status,"in_progress");assert.equal(operation.completedAt??null,null);
	state="failed";
	await h.orch.observeJobs();
	assert.equal(operation.status,"failed");assert.equal(operation.error,"export failed");
	assert.equal(h.calls.importSends,0);assert.equal(h.calls.unlockRouteTaken,0);
});

test("standalone import and source export observation restart without replay or fabricated duration", () => {
	const h = makeHarness(() => {throw Error("must not replay");});
	h.plugin.persistedTransactionLogs = ["import","export"].map(kind => ({transferId:`${kind}:1`,transferInfo:{
		operationType:kind,status:kind==="import"?"awaiting_completion":"in_progress",sourceInstanceId:1,targetInstanceId:2,
		platformName:"fixture",platformIndex:3,sourceExportId:"source-job",destinationJobId:"import_1",observedDurationMs:123,
	}}));
	h.orch.restoreImportObservations();
	for (const operation of h.activeTransfers.values()) {
		assert.equal(operation.observedDurationMs??null,null);assert.equal(operation.completedAt??null,null);
		assert.equal(operation.jobObservation.state,"unavailable");
	}
	assert.equal(h.activeTransfers.get("import:1").destinationJobId,"import_1");
	assert.equal(h.activeTransfers.get("export:1").sourceExportId,"source-job");
	assert.equal(h.calls.importSends,0);h.orch.stop();
});

test("an unusable queue journal refuses direct gateway admission without unlocking or importing", async t => {
	const fs = require("node:fs/promises"), os = require("node:os");
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "se-direct-admission-"));
	t.after(() => fs.rm(dir, {recursive: true, force: true}));
	const journal = path.join(dir, "queue.json");
	await fs.writeFile(journal, "{invalid");
	const h = makeHarness(() => ({success: true}));
	t.after(() => h.orch.requestQueue.stop());
	await h.orch.requestQueue.init(journal);
	const result = await h.orch.transferPlatform("1:gateway", 2);
	for (const transfer of h.activeTransfers.values()) clearTimeout(transfer.validationTimeout);
	assert.equal(result.success, false);
	assert.equal(result.safeToUnlockSource, false, "unknown prior delivery cannot authorize unlock");
	assert.equal(h.calls.importSends, 0);
	assert.equal(h.calls.unlockRouteTaken, 0);
	assert.equal(await fs.readFile(journal, "utf8"), "{invalid");
});

test("acknowledged recovery releases the queue reservation; failed cleanup retains it", async () => {
	let accepted = false;
	const h = makeHarness(() => ({success: true}), msg =>
		msg.constructor.name === "DeleteSourcePlatformRequest" ? {success: accepted, error: "offline"} : {success: true});
	const start = await h.orch.transferPlatform("1:reserved", 2);
	const transfer = onlyTransfer(h.activeTransfers);
	clearTimeout(transfer.validationTimeout);
	h.orch.handleStartPlatformTransferRequestMeasured = async () => ({success: false, error: "reply unavailable"});
	await h.orch.runQueuedRequest({id: "request:reserved", request: {}, operation: transfer});
	assert.equal(transfer.status, "cleanup_failed", "admission failure must remain eligible for recovery");
	assert.equal(transfer.timingPendingRecovery, true);
	h.plugin.pendingTransfers = new Map([[start.transferId, h.calls.pendingPersisted]]);
	await h.orch.recoverPendingTransfers();
	assert.equal(transfer.timingPendingRecovery, true);
	accepted = true;
	await h.orch.recoverPendingTransfers();
	assert.equal(transfer.status, "completed");
	assert.equal(transfer.timingPendingRecovery, false);
	assert.equal(h.calls.importSends, 1, "recovery must not repeat import");
});

test("successful transfer verifies the held destination, deletes source, then activates once", async () => {
	const order = [];
	const notices = [];
	const { orch, activeTransfers, calls } = makeHarness(() => ({ success: true }), msg => {
		if (msg.constructor.name === "TransferStatusUpdate") { notices.push(msg.message); return { success: true }; }
		order.push(msg.action || msg.constructor.name);
		return { success: true };
	});
	const result = await orch.transferPlatform("export_1", 2);
	await Promise.all([1, 2].map(() => orch.handleTransferValidation({ transferId: result.transferId, success: true })));
	assert.deepEqual(order, ["verify", "DeleteSourcePlatformRequest", "go_live"]);
	assert.equal(onlyTransfer(activeTransfers).status, "completed");
	assert.equal(calls.pendingRemoved, result.transferId);
	assert.equal(calls.openPhases.has("cleanup"), false);
	assert.deepEqual(notices, [], "controller duplicated Lua arrival/departure notices");
});

test("validation rejection broadcasts one final abort reason per involved instance", async t => {
	const notices = [];
	const h = makeHarness(() => ({success: true}), msg => {
		if (msg.constructor.name === "TransferStatusUpdate") notices.push(msg.message);
		return {success: true};
	});
	t.after(() => h.orch.stop());
	const result = await h.orch.transferPlatform("export_1", 2);
	await Promise.all([1, 2].map(() => h.orch.handleTransferValidation({
		transferId: result.transferId, success: false, validation: {mismatchDetails: "belt item count mismatch"},
	})));
	assert.deepEqual(notices, Array(2).fill("Platform 'test-platform' aborted transfer: belt item count mismatch"));
	assert.equal(onlyTransfer(h.activeTransfers).status, "failed");
});

test("lost activation reply never announces an aborted transfer", async t => {
	const notices = [];
	const h = makeHarness(() => ({success: true}), msg => {
		if (msg.constructor.name === "TransferStatusUpdate") notices.push(msg.message);
		if (msg.action === "go_live") throw sessionLost("activation reply lost");
		return {success: true};
	});
	t.after(() => h.orch.stop());
	const result = await h.orch.transferPlatform("export_1", 2);
	await h.orch.handleTransferValidation({transferId: result.transferId, success: true});
	assert.equal(onlyTransfer(h.activeTransfers).status, "cleanup_failed");
	assert.deepEqual(notices, []);
});

for (const restart of [false, true]) {
	test(`recovery retries a lost deletion reply without importing again (restart=${restart})`, async () => {
		let deletionCalls = 0, releases = 0;
		const h = makeHarness(() => ({ success: true }), msg => {
			if (msg.constructor.name === "DeleteSourcePlatformRequest" && ++deletionCalls === 1) throw sessionLost();
			if (msg.action === "go_live") releases++;
			return { success: true };
		});
		const start = await h.orch.transferPlatform("1:export_1", 2);
		await h.orch.handleTransferValidation({ transferId: start.transferId, success: true });
		assert.equal(onlyTransfer(h.activeTransfers).status, "cleanup_failed");
		h.plugin.pendingTransfers = new Map([[start.transferId, h.calls.pendingPersisted]]);
		if (restart) {
			h.activeTransfers.clear();
			h.orch = new TransferOrchestrator(h.plugin, messages);
		}
		await Promise.all([h.orch.recoverPendingTransfers(), h.orch.recoverPendingTransfers()]);
		assert.equal(onlyTransfer(h.activeTransfers).status, "completed");
		assert.equal(onlyTransfer(h.activeTransfers).error, null);
		assert.equal(h.calls.importSends, 1);
		assert.equal(deletionCalls, 2);
		assert.equal(releases, 1);
		assert.equal(h.calls.pendingRemoved, start.transferId);
	});
}

test("recovery does not delete on missing destination evidence or overwrite an active import", async () => {
	let deletions = 0;
	const h = makeHarness(() => ({ success: true }), msg => {
		if (msg.constructor.name === "DeleteSourcePlatformRequest") deletions++;
		return { success: false, error: "hold unavailable" };
	});
	const start = await h.orch.transferPlatform("1:export_1", 2);
	h.plugin.pendingTransfers = new Map([[start.transferId, h.calls.pendingPersisted]]);
	const original = onlyTransfer(h.activeTransfers);
	await h.orch.recoverPendingTransfers();
	assert.equal(onlyTransfer(h.activeTransfers), original);
	assert.equal(original.status, "awaiting_validation");
	await h.orch.handleTransferValidation({ transferId: start.transferId, success: true });
	await h.orch.recoverPendingTransfers();
	assert.equal(deletions, 0);
	assert.equal(h.calls.importSends, 1);
	assert.equal(h.calls.pendingRemoved, undefined);
});

test("failed recovery-intent persistence prevents source deletion", async () => {
	const sends = [];
	const h = makeHarness(() => ({ success: true }), msg => { sends.push(msg.constructor.name); return { success: true }; });
	const start = await h.orch.transferPlatform("1:export_1", 2);
	h.plugin.persistPendingTransfers = async () => { throw new Error("disk full"); };
	await h.orch.handleTransferValidation({ transferId: start.transferId, success: true });
	assert.equal(onlyTransfer(h.activeTransfers).status, "cleanup_failed");
	assert.equal(sends.includes("DeleteSourcePlatformRequest"), false);
	assert.equal(h.calls.pendingRemoved, undefined);
});

test("actual timeout retains uncertainty and accepts a later genuine verdict", async () => {
	const timers = [], original = global.setTimeout;
	const h = makeHarness(() => ({ success: true }));
	let start;
	global.setTimeout = (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; };
	try { start = await h.orch.transferPlatform("1:export_1", 2); }
	finally { global.setTimeout = original; }
	await timers.find(timer => timer.ms === 30_000).fn();
	const transfer = onlyTransfer(h.activeTransfers);
	assert.equal(transfer.status, "awaiting_validation");
 assert.equal(transfer.completedAt ?? null, null);
 assert.equal(transfer.jobObservation.message, "Status unavailable");
	assert.equal(transfer.validationResult, undefined, "missing reply is not failed cargo evidence");
	assert.equal(h.calls.unlockRouteTaken, 0);
	assert.equal(h.calls.pendingRemoved, undefined);
	await h.orch.handleTransferValidation({ transferId: start.transferId, success: true,
		validation: { itemCountMatch: true, fluidCountMatch: true } });
	assert.equal(transfer.status, "completed");
	assert.equal(transfer.validationResult.itemCountMatch, true);
	assert.equal(h.calls.importSends, 1);
});

test("queued Lua work past the observation threshold survives controller recovery without deletion", async () => {
	const timers = [], original = global.setTimeout;
	let deletes = 0;
	const h = makeHarness(() => ({success:true,jobId:"import_7",epoch:"runtime-1"}), msg => {
		if (msg.constructor.name === "JobsStatusRequest") return {version:1,epoch:"runtime-1",observedTick:2400,
			jobs:msg.jobs.map(ref=>({...ref,state:"queued",phase:"tiles",work:{entities:0},observedTick:2400}))};
		if (msg.constructor.name === "DeleteSourcePlatformRequest") deletes++;
		return {success:false,error:"no completed hold yet"};
	});
	global.setTimeout=(fn,ms)=>{const timer={fn,ms};timers.push(timer);return timer;};
	let started;
	try {started=await h.orch.transferPlatform("1:queued",2);} finally {global.setTimeout=original;}
	await timers.find(t=>t.ms===30_000).fn();
	const operation=onlyTransfer(h.activeTransfers);
	assert.equal(operation.jobObservation.message,"Waiting in Lua queue");
	assert.equal(operation.completedAt??null,null);
	h.plugin.pendingTransfers=new Map([[started.transferId,h.calls.pendingPersisted]]);
	h.activeTransfers.clear();
	await h.orch.recoverPendingTransfers();
	assert.equal(onlyTransfer(h.activeTransfers).status,"awaiting_validation");
	assert.equal(onlyTransfer(h.activeTransfers).completedAt??null,null);
	assert.equal(deletes,0); assert.equal(h.calls.unlockRouteTaken,0); assert.equal(h.calls.importSends,1);
});

for (const failure of ["verify", "delete-refused", "delete-lost", "activate-lost"]) {
	test(`transfer gate fails closed on ${failure}`, async () => {
		const order = [];
		const { orch, activeTransfers, calls } = makeHarness(() => ({ success: true }), msg => {
			if (msg.constructor.name === "TransferStatusUpdate") return { success: true };
			const step = msg.action || msg.constructor.name;
			order.push(step);
			if (failure === "verify" && step === "verify") return { success: false, error: "hold missing" };
			if (failure === "delete-refused" && step === "DeleteSourcePlatformRequest") return { success: false, error: "deletion failed" };
			if ((failure === "delete-lost" && step === "DeleteSourcePlatformRequest")
				|| (failure === "activate-lost" && step === "go_live")) throw sessionLost();
			return { success: true };
		});
		const result = await orch.transferPlatform("export_1", 2);
		await orch.handleTransferValidation({ transferId: result.transferId, success: true });
		assert.equal(onlyTransfer(activeTransfers).status, "cleanup_failed");
		assert.equal(calls.pendingRemoved, undefined, "uncertain outcome retains recovery intent");
		assert.equal(calls.unlockRouteTaken, 0, "uncertain deletion cannot authorize rollback");
		assert.equal(calls.openPhases.has("cleanup"), false);
		if (failure === "verify") assert.deepEqual(order, ["verify"]);
		else if (failure !== "activate-lost") assert.deepEqual(order, ["verify", "DeleteSourcePlatformRequest"]);
	});
}

test("isSessionLostError: true only for code === 'SessionLost'", () => {
	assert.equal(isSessionLostError(sessionLost()), true);
	assert.equal(isSessionLostError(sessionLost("Session Lost")), true);
	assert.equal(isSessionLostError(new Error("network down")), false);
	assert.equal(isSessionLostError({ code: "OtherError" }), false);
	assert.equal(isSessionLostError(null), false);
	assert.equal(isSessionLostError("SessionLost"), false);
});

test("SessionLost on import send: source NOT unlocked, transfer enters awaiting_validation (#80)", async () => {
	const { orch, activeTransfers, calls } = makeHarness(() => { throw sessionLost("Session Closed"); });

	const res = await orch.transferPlatform("export_1", 2);

	assert.equal(calls.importSends, 1, "the import send must have been attempted");
	assert.equal(calls.unlockRouteTaken, 0, "source must NOT be unlocked on an ambiguous SessionLost");

	const transfer = onlyTransfer(activeTransfers);
	assert.equal(transfer.status, "awaiting_validation", "must arm validation, not roll back");
	assert.ok(transfer.validationTimeout, "the validation timeout must be armed to resolve it later");
	assert.ok(calls.events.includes("import_delivery_uncertain"), "the uncertain-delivery route must be logged");
	assert.equal(calls.openPhases.has("transmission"), false, "transmission phase must be closed on the recovery path");
	assert.equal(calls.openPhases.has("validation"), true, "validation phase is open while awaiting validation");

	assert.equal(res.success, true, "the transfer continues through the state machine");
	assert.ok(res.transferId, "a transferId is returned so the caller can track it");

	clearTimeout(transfer.validationTimeout);
});

test("confirmed routing rejection before import dispatch permits source rollback", async () => {
	const { orch, activeTransfers, calls } = makeHarness(() => { throw new (require("@clusterio/lib").RequestError)("Instance is not running."); });

	const res = await orch.transferPlatform("export_1", 2);

	assert.equal(calls.importSends, 1, "the import send must have been attempted");
	assert.equal(calls.unlockRouteTaken, 1, "a definite non-delivery error must roll back (unlock) the source");

	const transfer = onlyTransfer(activeTransfers);
	assert.notEqual(transfer.status, "awaiting_validation", "a definite failure must not enter awaiting_validation");
	assert.equal(res.success, false);

	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);
});

test("unknown import dispatch error retains source ownership", async t => {
	const h = makeHarness(() => {throw Error("socket send failed after buffering");});
	t.after(() => h.orch.stop());
	assert.equal((await h.orch.transferPlatform("1:unknown-send", 2)).success, true);
	assert.equal(h.calls.unlockRouteTaken, 0);
	assert.equal(onlyTransfer(h.activeTransfers).status, "awaiting_validation");
});

test("failed canonical queue promotion retains a same-process source observer", async t => {
	const h = makeHarness(() => {throw Error("must not import");}, () => ({success: true, exportId: "promotion"}));
	t.after(() => h.orch.stop());
	h.plugin.controller.instances = new Map([[1, {id: 1}]]);
	h.plugin.platformTree.resolveTargetInstance = id => ({id});
	h.plugin.transactionLogs = new Map(); h.plugin.persistedTransactionLogs = [];
	h.orch.waitForStoredExport = async () => ({});
	const id = "request:promotion", request = {sourceInstanceId: 1, sourcePlatformIndex: 3, targetInstanceId: 2};
	const operation = {transferId: id, operationType: "transfer", sourceInstanceId: 1, targetInstanceId: 2,
		platformIndex: 3, status: "preparing", startedAt: Date.now()};
	const entry = {id, request, operation};
	h.activeTransfers.set(id, operation); h.orch.requestQueue.entries.set(id, entry);
	let writes = 0;
	h.orch.requestQueue.persist = async () => {if (++writes === 2) throw Error("injected promotion write failure");};
	const {timingContext} = require(path.join(distNode, "lib/timing.js"));
	await timingContext.run(h.plugin.txLogger.clock(id), () => h.orch.handleStartPlatformTransferRequestMeasured(request, id));
	assert.equal(h.activeTransfers.get(id), operation); assert.equal(entry.operation, operation);
	assert.equal(operation.status, "preparing");
	h.orch.observationDue.set(id, 0);
	h.orch.observer.poll = async () => ({version: 1, epoch: "runtime", jobs: [{jobId: "promotion", state: "completed"}]});
	await h.orch.observeJobs();
	assert.equal(operation.status, "failed"); assert.equal(operation.timingPendingRecovery, false);
	assert.equal(h.calls.unlockRouteTaken, 1); assert.equal(h.calls.importSends, 0);
});

test("definite import rejection keeps source cleanup observable through restart", async t => {
	const fs = require("node:fs/promises"), os = require("node:os");
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "se-rejected-cleanup-"));
	t.after(() => fs.rm(dir, {recursive: true, force: true}));
	for (const routing of [false, true]) {
		const h = makeHarness(() => {
			if (routing) throw new (require("@clusterio/lib").RequestError)("Instance is not running.");
			return {success: false, error: "rejected before admission"};
		}, () => ({success: true, exportId: "rejected"})); t.after(() => h.orch.stop());
		h.plugin.controller.instances = new Map([[1, {id: 1}]]);
		h.plugin.platformTree.resolveTargetInstance = id => ({id});
		h.plugin.transactionLogs = new Map(); h.plugin.persistedTransactionLogs = [];
		h.orch.waitForStoredExport = async () => ({});
		const file = path.join(dir, `${routing}.json`);
		await h.orch.requestQueue.init(file);
		const id = "request:rejected", request = {sourceInstanceId: 1, targetInstanceId: 2, sourcePlatformIndex: 3};
		const entry = {id, request, operation: {transferId: id, operationType: "transfer", sourceInstanceId: 1,
			targetInstanceId: 2, platformIndex: 3, status: "preparing", startedAt: Date.now()}};
		h.activeTransfers.set(id, entry.operation); h.orch.requestQueue.entries.set(id, entry);
		h.orch.tryUnlockSource = async () => "source offline";
		await h.orch.runQueuedRequest(entry);
		const operation = onlyTransfer(h.activeTransfers);
		assert.equal(entry.operation, operation); assert.equal(operation.transferId, "1:rejected");
		assert.equal(operation.status, "preparing"); assert.equal(operation.timingPendingRecovery, true);
		h.orch.stop();
		const restored = makeHarness(() => {throw Error("must not replay");}); t.after(() => restored.orch.stop());
		restored.plugin.persistedTransactionLogs = [];
		await restored.orch.requestQueue.init(file);
		const pending = onlyTransfer(restored.activeTransfers);
		assert.equal(pending.timingPendingRecovery, true);
		restored.orch.observationDue.set(pending.transferId, 0);
		restored.orch.observer.poll = async () => ({version: 1, epoch: "runtime", jobs: [{jobId: "rejected", state: "completed"}]});
		await restored.orch.observeJobs();
		assert.equal(pending.status, "failed"); assert.equal(pending.timingPendingRecovery, false);
		assert.equal(restored.calls.unlockRouteTaken, 1); assert.equal(restored.calls.importSends, 0);
	}
});

test("concurrent observation cannot unlock before cancellation persistence succeeds", async t => {
	for (const fail of [false, true]) {
		const h = makeHarness(() => {throw Error("must not import");}); t.after(() => h.orch.stop());
		const id = "1:cancel-write", operation = {transferId: id, operationType: "transfer", sourceInstanceId: 1,
			targetInstanceId: 2, platformIndex: 3, sourceExportId: "cancel-write", status: "transporting"};
		h.activeTransfers.set(id, operation); h.orch.requestQueue.handoffs.set(id, {destination: 2});
		let release;
		h.orch.requestQueue.persist = () => new Promise((resolve, reject) => {release = () => fail ? reject(Error("disk full")) : resolve();});
		const rejected = h.orch.handleImportFailure(id, "admission rejected", 1);
		const handled = rejected.catch(error => error);
		await new Promise(resolve => setImmediate(resolve));
		h.orch.observationDue.set(id, 0);
		h.orch.observer.poll = async () => ({version: 1, epoch: "runtime", jobs: [{jobId: "cancel-write", state: "completed"}]});
		const observation = h.orch.observeJobs().catch(error => error);
		await new Promise(resolve => setImmediate(resolve)); assert.equal(h.calls.unlockRouteTaken, 0);
		release(); await handled; await observation;
		assert.equal(h.calls.unlockRouteTaken, fail ? 0 : 1);
		if (fail) {await h.orch.reconcileInterruptedSource(operation); assert.equal(h.calls.unlockRouteTaken, 0);}
	}
});

test("a refused destination cannot race source cleanup with another handoff", async t => {
	const h = makeHarness(() => ({success: true}), () => ({success: true, exportId: "refused"}));
	t.after(() => h.orch.stop());
	h.plugin.controller.instances = new Map([[1, {id: 1}]]);
	h.plugin.platformTree.resolveTargetInstance = id => ({id});
	h.plugin.recoveryReservations = new Map([[2, {}]]);
	h.orch.waitForStoredExport = async () => ({});
	let release;
	h.orch.sendUnlockRequest = () => new Promise(resolve => {release = resolve;});
	const request = h.orch.handleStartPlatformTransferRequestMeasured({sourceInstanceId: 1, sourcePlatformIndex: 3, targetInstanceId: 2}, "request:refused");
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(typeof release, "function");
	assert.equal((await h.orch.transferPlatform("1:refused", 3)).success, false);
	assert.equal(h.calls.importSends, 0);
	release(null);
	assert.equal((await request).success, false);
});

test("restart between canonical queue persistence and dispatch claim cleans only the source", async t => {
	const fs = require("node:fs/promises"), os = require("node:os");
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "se-before-claim-"));
	t.after(() => fs.rm(dir, {recursive: true, force: true}));
	const file = path.join(dir, "queue.json");
	const h = makeHarness(() => {throw Error("must not import");}); t.after(() => h.orch.stop());
	h.plugin.persistedTransactionLogs = [];
	const operation = {transferId: "1:before-claim", sourceExportId: "before-claim", operationType: "transfer",
		sourceInstanceId: 1, targetInstanceId: 2, platformIndex: 3, status: "transporting"};
	await fs.writeFile(file, JSON.stringify({v: 2, handoffs: [], entries: [{id: "request:1", request: {}, operation}]}));
	await h.orch.requestQueue.init(file);
	const restored = onlyTransfer(h.activeTransfers);
	assert.equal(restored.status, "preparing");
	h.orch.observationDue.set(restored.transferId, 0);
	h.orch.observer.poll = async () => ({version: 1, epoch: "runtime", jobs: [{jobId: "before-claim", state: "completed"}]});
	await h.orch.observeJobs();
	assert.equal(restored.status, "failed");
	assert.equal(restored.timingPendingRecovery, false);
	assert.equal(h.calls.unlockRouteTaken, 1); assert.equal(h.calls.importSends, 0);
});

test("unconfirmed standalone export is found by operation identity without re-export", async t => {
	const h = makeHarness(() => {throw Error("must not import");}); t.after(() => h.orch.stop());
	h.plugin.platformStorage = new Map();
	const operation = {transferId: "export:lost", operationType: "export", sourceInstanceId: 1,
		targetInstanceId: -1, platformIndex: 3, status: "in_progress"};
	h.activeTransfers.set(operation.transferId, operation);
	await h.orch.observeUnconfirmedExport(operation, "Reply lost");
	h.orch.observationDue.set(operation.transferId, 0);
	h.orch.observer.poll = async (_instance, jobs) => {
		assert.deepEqual(jobs, [{operationId: operation.transferId}]);
		return {version: 1, epoch: "runtime", jobs: [{operationId: operation.transferId, jobId: "download", state: "completed"}]};
	};
	h.orch.recoverExportArtifact = async () => h.plugin.platformStorage.set("1:download", {
		exportId: "1:download", sourceExportId: "download", instanceId: 1, exportData: {}, size: 12,
	});
	await h.orch.observeJobs();
	assert.equal(operation.sourceExportId, "download"); assert.equal(operation.status, "in_progress");
	await h.orch.observeJobs();
	assert.equal(operation.status, "completed");
	assert.equal(h.calls.importSends, 0); assert.equal(h.calls.unlockRouteTaken, 0);
});

test("#106: validation fails AND source unlock fails → status is plain 'failed', intent still KEPT", async () => {
	const { orch, activeTransfers, calls } = makeHarness(() => { throw sessionLost("Session Closed"); });
	const res = await orch.transferPlatform("export_1", 2);
	const transfer = onlyTransfer(activeTransfers);
	assert.equal(transfer.status, "awaiting_validation");
	assert.ok(calls.pendingPersisted, "the recovery intent was persisted on awaiting_validation");
	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);

	orch.tryUnlockSource = async () => { calls.unlockRouteTaken++; return "unlock failed: source offline"; };
	calls.pendingRemoved = undefined;

	await orch.handleTransferValidation({ transferId: res.transferId, success: false, validation: { mismatchDetails: "item mismatch" } });

	assert.equal(transfer.status, "failed",
		"a failed unlock is TTL-self-healing and leaves no platform behind — it must not wear the "
		+ "leftover-platform status");
	assert.match(String(transfer.error), /unlock failed: source offline/,
		"the unlock failure still rides in the error text");
	assert.equal(calls.pendingRemoved, undefined, "the recovery intent must be KEPT until explicit resolution");
});

test("a failed DESTINATION discard is cleanup_failed — a platform was left behind", async () => {
	const { orch, activeTransfers, calls } = makeHarness(() => { throw sessionLost("Session Closed"); });
	const res = await orch.transferPlatform("export_1", 2);
	const transfer = onlyTransfer(activeTransfers);
	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);

	orch.tryUnlockSource = async () => { calls.unlockRouteTaken++; return null; };
	calls.pendingRemoved = undefined;

	await orch.handleTransferValidation({ transferId: res.transferId, success: false, validation: {
		mismatchDetails: "item mismatch",
		cleanup_failed: true,
		cleanup_error: "GameUtils.delete_platform failed: returned false",
	} });

	assert.equal(transfer.status, "cleanup_failed");
	assert.match(String(transfer.error), /delete_platform failed/);
	assert.equal(calls.pendingRemoved, res.transferId,
		"the SOURCE is resolved (unlocked), so the intent is dropped — the orphan is on the target "
		+ "side and stays visible through the cleanup_failed record itself");
});

test("preflight: an offline destination is refused BEFORE any record exists", async () => {
	const { orch, activeTransfers, calls } = makeHarness(() => {
		throw new Error("import send must never be reached when the preflight refuses");
	});
	calls.offlineInstances = new Set([2]);

	const res = await orch.transferPlatform("export_1", 2);

	assert.equal(res.success, false);
	assert.match(String(res.error), /offline/, "the player-facing message names the cause");
	assert.match(String(res.error), /unchanged/, "and says the source platform is safe");
	assert.equal(res.safeToUnlockSource, true,
		"the refusal must carry the unlock authority: nothing was sent, so the CALLERS — the "
		+ "instance's refusal path AND handleStartPlatformTransferRequest, whichever holds the "
		+ "source lock — may release it. (Review finding: without this flag the web/ctl path "
		+ "stranded its export-time lock for the full TTL.)");
	assert.equal(activeTransfers.size, 0,
		"NO record: a refused preflight must not burn the canonical ID or feed the retry guard");
	assert.equal(calls.importSends, 0, "nothing was sent anywhere");
	assert.equal(calls.unlockRouteTaken, 0,
		"transferPlatform itself does not unlock on the preflight — the LOCK HOLDER does, keyed on "
		+ "safeToUnlockSource (the instance path and the web path lock at different times, and only "
		+ "they know whether a lock exists to release)");

	calls.offlineInstances.clear();
	await orch.transferPlatform("export_1", 2);
	assert.equal(calls.importSends, 1, "back online, the preflight admits the transfer to the import send");
	const transfer = onlyTransfer(activeTransfers);
	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);
});

test("preflight: an auto-paused destination is refused BEFORE any record exists", async () => {
	const { orch, activeTransfers, calls } = makeHarness(() => {
		throw new Error("import send must never be reached when the destination is auto-paused");
	});
	calls.autoPaused = new Set([2]);

	const res = await orch.transferPlatform("export_1", 2);

	assert.equal(res.success, false);
	assert.match(String(res.error), /destination instance-2 has auto-pause on/);
	assert.match(String(res.error), /unchanged/);
	assert.equal(res.safeToUnlockSource, true, "nothing was sent, so the lock holder may release the source");
	assert.equal(activeTransfers.size, 0);
	assert.equal(calls.importSends, 0);
	assert.equal(calls.unlockRouteTaken, 0);

	calls.autoPaused.clear();
	await orch.transferPlatform("export_1", 2);
	assert.equal(calls.importSends, 1, "without auto-pause the same export reaches the import send");
	const transfer = onlyTransfer(activeTransfers);
	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);
});

test("preflight: an auto-paused source is refused before the import, with unlock authority", async () => {
	const { orch, activeTransfers, calls } = makeHarness(() => {
		throw new Error("import send must never be reached when the source is auto-paused");
	});
	calls.autoPaused = new Set([1]);
	const res = await orch.transferPlatform("export_1", 2);
	assert.equal(res.success, false);
	assert.match(String(res.error), /source instance-1 has auto-pause on/);
	assert.equal(res.safeToUnlockSource, true);
	assert.equal(activeTransfers.size, 0);
	assert.equal(calls.importSends, 0);
});

test("a throw AFTER the destination accepted must NOT authorize an unlock", async () => {
	const { orch, activeTransfers, calls } = makeHarness(() => ({ success: true }));
	const plugin = orch.plugin;
	plugin.persistPendingTransfer = () => { throw new Error("disk full persisting intent"); };

	const res = await orch.transferPlatform("export_1", 2);

	assert.equal(calls.importSends, 1, "the import was delivered and accepted");
	assert.equal(res.success, false, "the throw still fails the call");
	assert.notEqual(res.safeToUnlockSource, true,
		"a post-acceptance failure must NEVER authorize an unlock — the destination holds the copy");
	assert.equal(calls.unlockRouteTaken, 0,
		"and the orchestrator itself must not unlock either (the armed validation timeout resolves it)");
	const transfer = onlyTransfer(activeTransfers);
	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);
});

test("a failed transfer whose destination was deliberately PRESERVED is not replayable", async () => {
	const { orch, activeTransfers, calls } = makeHarness(() => { throw sessionLost("Session Closed"); });
	const res = await orch.transferPlatform("export_1", 2);
	const transfer = onlyTransfer(activeTransfers);
	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);
	orch.tryUnlockSource = async () => { calls.unlockRouteTaken++; return null; };

	await orch.handleTransferValidation({ transferId: res.transferId, success: false, validation: {
		mismatchDetails: "forced failure with preserve armed",
		destinationPreserved: true,
	} });
	assert.equal(transfer.status, "failed", "preservation is deliberate, not a leftover — status stays failed");

	const sendsBefore = calls.importSends;
	const retry = await orch.transferPlatform("export_1", 2);
	assert.equal(retry.success, false, "the replay must be refused");
	assert.match(String(retry.error), /PRESERVED/,
		"and the refusal must say WHY — the preserved copy is what a re-run would duplicate beside");
	assert.equal(calls.importSends, sendsBefore, "nothing may be sent on the refused replay");
});

test("#106: validation fails but source unlock SUCCEEDS → failed drops the intent (source resolved)", async () => {
	const { orch, activeTransfers, calls } = makeHarness(() => { throw sessionLost("Session Closed"); });
	const res = await orch.transferPlatform("export_1", 2);
	const transfer = onlyTransfer(activeTransfers);
	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);

	orch.tryUnlockSource = async () => { calls.unlockRouteTaken++; return null; };
	calls.pendingRemoved = undefined;

	await orch.handleTransferValidation({ transferId: res.transferId, success: false, validation: { mismatchDetails: "item mismatch" } });

	assert.equal(transfer.status, "failed", "failed validation + successful unlock is 'failed'");
	assert.equal(calls.pendingRemoved, res.transferId, "the recovery intent is dropped once the source is unlocked");
});


test("W1 guard: a late genuine SUCCESS after a recorded validation failure must NOT drive a source delete", async () => {
	const { orch, activeTransfers, calls, plugin } = makeHarness(() => ({ success: true }));
	const res = await orch.transferPlatform("export_1", 2);
	const transfer = onlyTransfer(activeTransfers);
	assert.equal(transfer.status, "awaiting_validation");
	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);

	calls.deleteSends = 0;
	const origSendTo = plugin.controller.sendTo;
	plugin.controller.sendTo = async (dst, msg) => {
		if (msg && msg.constructor && msg.constructor.name === "DeleteSourcePlatformRequest") calls.deleteSends++;
		return origSendTo(dst, msg);
	};

	await orch.handleTransferValidation({
		transferId: res.transferId, success: false,
		platformName: transfer.platformName, sourceInstanceId: transfer.sourceInstanceId,
		validation: { itemCountMatch: false, fluidCountMatch: false, mismatchDetails: "Validation rejected by destination" },
	});
	assert.equal(transfer.status, "failed", "the explicit rejection settles the transfer as failed (rollback ran)");
	assert.equal(calls.unlockRouteTaken, 1, "the rollback unlocked the source");

	await orch.handleTransferValidation({
		transferId: res.transferId, success: true,
		platformName: transfer.platformName, sourceInstanceId: transfer.sourceInstanceId,
		validation: { itemCountMatch: true, fluidCountMatch: true },
	});

	assert.equal(calls.deleteSends, 0,
		"a late SUCCESS on a settled transfer must never send DeleteSourcePlatformRequest "
		+ "- the source was already unlocked and returned to the player");
	assert.equal(transfer.status, "cleanup_failed",
		"REVIEW FINDING: the late-live destination is a platform left behind, so the record must wear "
		+ "cleanup_failed (its one meaning) - leaving it 'failed' (the one status retries may replace) "
		+ "turned the 'retry works' guidance into a second copy imported beside the orphan");
	assert.match(String(transfer.validationResult && transfer.validationResult.mismatchDetails),
		/rejected/i, "the settled record's verdict must not be overwritten by the late one");
	assert.ok(calls.events.includes("validation_after_settle"),
		"the refusal must be LOUD: a validation_after_settle event names the live-destination residual");

	const importSendsBefore = calls.importSends;
	const retry = await orch.transferPlatform("export_1", 2);
	assert.equal(retry.success, false, "retrying beside a live destination copy must be refused");
	assert.equal(calls.importSends, importSendsBefore, "no second import may be sent");
});

test("W1 guard: a late genuine FAILURE carrying destinationPreserved is ADOPTED (retry guard reads it)", async () => {
	const { orch, activeTransfers, calls } = makeHarness(() => ({ success: true }));
	const res = await orch.transferPlatform("export_1", 2);
	const transfer = onlyTransfer(activeTransfers);
	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);

	await orch.handleTransferValidation({
		transferId: res.transferId, success: false,
		platformName: transfer.platformName, sourceInstanceId: transfer.sourceInstanceId,
		validation: { itemCountMatch: false, fluidCountMatch: false, mismatchDetails: "Validation rejected by destination" },
	});
	assert.equal(transfer.status, "failed");

	await orch.handleTransferValidation({
		transferId: res.transferId, success: false,
		platformName: transfer.platformName, sourceInstanceId: transfer.sourceInstanceId,
		validation: { itemCountMatch: false, fluidCountMatch: false, mismatchDetails: "item mismatch", destinationPreserved: true },
	});

	assert.equal(transfer.status, "failed", "a self-resolved destination leaves nothing behind - status stays failed");
	assert.equal(transfer.validationResult && transfer.validationResult.destinationPreserved, true,
		"the genuine verdict (the only destinationPreserved carrier) must be adopted onto the record");
	const importSendsBefore = calls.importSends;
	const retry = await orch.transferPlatform("export_1", 2);
	assert.equal(retry.success, false, "the preserved-destination retry guard must now see the flag and refuse");
	assert.equal(calls.importSends, importSendsBefore);
});

test("validation timeout ceiling: 120s cap protects the source-lock TTL budget (and setTimeout)", async () => {
	const { orch, plugin } = makeHarness(() => ({ success: true }));
	plugin.controller.config = { get: () => 900 };
	assert.equal(orch.getValidationTimeoutMs(), 120_000,
		"above the Lua validation budget the lock could TTL-expire mid-wait - clamp to 120s");
	plugin.controller.config = { get: () => 1e12 };
	assert.equal(orch.getValidationTimeoutMs(), 120_000,
		"a huge value must clamp, never overflow setTimeout into a 1ms insta-timeout");
	plugin.controller.config = { get: () => 120 };
	assert.equal(orch.getValidationTimeoutMs(), 120_000, "the ceiling itself is allowed");
});

test("per-arm read is PINNED: the armed delay on the record equals the configured value", async () => {
	const { orch, plugin, activeTransfers } = makeHarness(() => ({ success: true }));
	plugin.controller.config = { get: () => 45 };
	await orch.transferPlatform("export_1", 2);
	const transfer = onlyTransfer(activeTransfers);
	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);
	assert.equal(transfer.armedValidationTimeoutMs, 45_000,
		"the timer must be armed with the live config value, not a cached or default one");
});

test("a throwing config accessor cannot strand a transfer outside awaiting_validation", async () => {
	const { orch, activeTransfers, plugin } = makeHarness(() => ({ success: true }));
	plugin.controller.config = { get: () => { throw new Error("InvalidField: not registered"); } };
	const res = await orch.transferPlatform("export_1", 2);
	assert.equal(res.success, true, "the transfer must proceed on the default timeout");
	const transfer = onlyTransfer(activeTransfers);
	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);
	assert.equal(transfer.status, "awaiting_validation",
		"the record must reach awaiting_validation - anything else is terminal under the guard");
	assert.equal(transfer.armedValidationTimeoutMs, 30_000, "default armed when the accessor throws");
});

test("W1 guard: a late FAILURE after a completed transfer must not roll back", async () => {
	const { orch, activeTransfers, calls } = makeHarness(() => ({ success: true }));
	const res = await orch.transferPlatform("export_1", 2);
	const transfer = onlyTransfer(activeTransfers);
	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);

	await orch.handleTransferValidation({
		transferId: res.transferId, success: true,
		platformName: transfer.platformName, sourceInstanceId: transfer.sourceInstanceId,
		validation: { itemCountMatch: true, fluidCountMatch: true },
	});
	assert.equal(transfer.status, "completed");
	const unlocksAfterCompletion = calls.unlockRouteTaken;

	await orch.handleTransferValidation({
		transferId: res.transferId, success: false,
		platformName: transfer.platformName, sourceInstanceId: transfer.sourceInstanceId,
		validation: { itemCountMatch: false, fluidCountMatch: false, mismatchDetails: "late duplicate" },
	});

	assert.equal(transfer.status, "completed", "a completed transfer must stay completed");
	assert.equal(calls.unlockRouteTaken, unlocksAfterCompletion,
		"no rollback: unlocking a deleted source is at best a spurious error, and the record must not flip");
	assert.ok(calls.events.includes("validation_after_settle"), "the late verdict is loudly logged, not silently dropped");
});

test("validation timeout config: default 30s, floor 5s, junk-safe, read per-arm", async () => {
	const { orch, plugin, activeTransfers } = makeHarness(() => ({ success: true }));

	assert.equal(orch.getValidationTimeoutMs(), 30_000, "no config accessor (unit harness) -> declared default");

	plugin.controller.config = { get: (field) => {
		assert.equal(field, "surface_export.transfer_validation_timeout_seconds");
		return 45;
	} };
	assert.equal(orch.getValidationTimeoutMs(), 45_000, "configured value is used");

	plugin.controller.config = { get: () => 2 };
	assert.equal(orch.getValidationTimeoutMs(), 5_000, "floor 5s: a typo cannot make every transfer insta-timeout");

	plugin.controller.config = { get: () => "banana" };
	assert.equal(orch.getValidationTimeoutMs(), 30_000, "junk -> default");

	plugin.controller.config = { get: () => 0 };
	assert.equal(orch.getValidationTimeoutMs(), 30_000, "0 would disable the timeout entirely -> default");

	let reads = 0;
	plugin.controller.config = { get: () => { reads++; return 45; } };
	await orch.transferPlatform("export_1", 2);
	const transfer = onlyTransfer(activeTransfers);
	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);
	assert.ok(reads >= 1, "scheduleValidationTimeout must read the live config at arm time");
});

test("W1 guard: a late FAILURE reporting cleanup_failed marks the ACCIDENTAL orphan like the deliberate one", async () => {
	const { orch, activeTransfers, calls } = makeHarness(() => ({ success: true }));
	const res = await orch.transferPlatform("export_1", 2);
	const transfer = onlyTransfer(activeTransfers);
	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);

	await orch.handleTransferValidation({
		transferId: res.transferId, success: false,
		platformName: transfer.platformName, sourceInstanceId: transfer.sourceInstanceId,
		validation: { itemCountMatch: false, fluidCountMatch: false, mismatchDetails: "Validation rejected by destination" },
	});
	assert.equal(transfer.status, "failed");

	await orch.handleTransferValidation({
		transferId: res.transferId, success: false,
		platformName: transfer.platformName, sourceInstanceId: transfer.sourceInstanceId,
		validation: { itemCountMatch: false, fluidCountMatch: false, mismatchDetails: "item mismatch",
			cleanup_failed: true, cleanup_error: "GameUtils.delete_platform failed: returned false" },
	});

	assert.equal(transfer.status, "cleanup_failed",
		"an engine-refused discard leaves an orphan - the accidental orphan must refuse retries "
		+ "exactly like the deliberate destinationPreserved one");
	assert.match(String(transfer.error), /orphan copy remains/);
	const importSendsBefore = calls.importSends;
	const retry = await orch.transferPlatform("export_1", 2);
	assert.equal(retry.success, false, "retrying beside the orphan must be refused");
	assert.equal(calls.importSends, importSendsBefore, "no second import may be sent");
});

test("timeout config warnings: junk SET values warn, in-range fractionals do not", async () => {
	const { orch, plugin } = makeHarness(() => ({ success: true }));
	const warns = [];
	plugin.logger.warn = (msg) => { warns.push(String(msg)); };

	plugin.controller.config = { get: () => 30.5 };
	assert.equal(orch.getValidationTimeoutMs(), 30_000);
	assert.equal(warns.length, 0, "an in-range fractional is not a misconfiguration - no false warn");

	plugin.controller.config = { get: () => "banana" };
	assert.equal(orch.getValidationTimeoutMs(), 30_000);
	assert.equal(warns.length, 1, "a SET junk value must be visible, not silently corrected");
	assert.match(warns[0], /not a positive number/);

	plugin.controller.config = { get: () => 900 };
	assert.equal(orch.getValidationTimeoutMs(), 120_000);
	assert.equal(warns.length, 2, "an out-of-range value warns");
	assert.match(warns[1], /outside/);

	plugin.controller.config = { get: () => undefined };
	assert.equal(orch.getValidationTimeoutMs(), 30_000);
	assert.equal(warns.length, 2, "UNSET is the normal default case - silent");

	plugin.controller.config = { get: () => null };
	assert.equal(orch.getValidationTimeoutMs(), 30_000);
	assert.equal(warns.length, 2, "a CLEARED optional field (null) is not a misconfiguration - silent");
});

test("compressed source identity and force survive canonical promotion", async t => {
    for (const envelope of [{compressed:true,compression:"deflate",payload:"test"},
        {section_codec:1,section_count:1,sections:["test"]}]) {
        const h=makeHarness(() => ({success:true}));
        t.after(() => h.orch.stop());
        h.plugin.platformStorage.get=()=>({exportData:withLineage({...envelope,platform_uid:"selected-copy",force_name:"engineers"}),
            platformName:"renamed",platformIndex:3,instanceId:1,size:123});
        const result=await h.orch.transferPlatform("1:force-export",2);
        assert.equal(result.success,true);
        const operation=onlyTransfer(h.activeTransfers);
        assert.equal(operation.platformUid,"selected-copy");
        assert.equal(operation.forceName,"engineers");
        const {PlatformTree}=require(path.join(distNode,"lib","platform-tree.js"));
        const tree=new PlatformTree(h.plugin,messages);
        const [row]=tree.applyActiveTransferState([{platformIndex:3,platformUid:"selected-copy",forceName:"engineers"}],1);
        assert.equal(row.transferId,"1:force-export");
    }
});

test("the source passenger manifest is stored on the transfer and forwarded with go_live", async t => {
	const passengers = [{name: "alice", items: [{name: "power-armor", count: 1}]}, {name: "bob", items: []}];
	const gates = [];
	const h = makeHarness(() => ({success: true}), msg => {
		if (msg.constructor.name === "DeleteSourcePlatformRequest") return {success: true, passengers};
		if (msg.constructor.name === "DestinationTransferGateRequest") gates.push(msg.toJSON());
		return {success: true};
	});
	t.after(() => h.orch.stop());
	const result = await h.orch.transferPlatform("1:export_1", 2);
	await h.orch.handleTransferValidation({transferId: result.transferId, success: true});
	const transfer = onlyTransfer(h.activeTransfers);
	assert.equal(transfer.status, "completed");
	assert.deepEqual(transfer.passengers, passengers);
	assert.deepEqual(gates.map(gate => gate.action), ["verify", "go_live"]);
	assert.equal(gates[0].passengers, undefined);
	assert.deepEqual(gates[1].passengers, passengers);
});

for (const replayCarriesManifest of [true, false]) {
	test(`a retried go_live forwards the same passengers (replay carries manifest=${replayCarriesManifest})`, async t => {
		const passengers = [{name: "alice", items: [{name: "modular-armor", count: 1}]}];
		const goLive = [];
		let deletes = 0;
		const h = makeHarness(() => ({success: true}), msg => {
			if (msg.constructor.name === "DeleteSourcePlatformRequest") {
				deletes++;
				return deletes === 1 || replayCarriesManifest ? {success: true, passengers} : {success: true};
			}
			if (msg.constructor.name === "DestinationTransferGateRequest" && msg.action === "go_live") {
				goLive.push(msg.toJSON().passengers);
				if (goLive.length === 1) return {success: false, error: "activation refused"};
			}
			return {success: true};
		});
		t.after(() => h.orch.stop());
		const start = await h.orch.transferPlatform("1:export_1", 2);
		await h.orch.handleTransferValidation({transferId: start.transferId, success: true});
		const transfer = onlyTransfer(h.activeTransfers);
		assert.equal(transfer.status, "cleanup_failed");
		h.plugin.pendingTransfers = new Map([[start.transferId, h.calls.pendingPersisted]]);
		await h.orch.recoverPendingTransfers();
		assert.equal(transfer.status, "completed");
		assert.equal(deletes, 2);
		assert.deepEqual(goLive, [passengers, passengers]);
		assert.equal(h.calls.importSends, 1);
	});
}

test("passenger manifests stay out of transfer summaries and transfer info", () => {
	const plugin = {
		transactionLogs: new Map(), activeTransfers: new Map(), persistedTransactionLogs: [], platformStorage: new Map(),
		auditIndex: new Map(), auditRevisions: new Map(),
		platformTree: {resolveInstanceName: id => `instance-${id}`},
		controller: {config: {get: () => undefined}},
		logger: {info() {}, warn() {}, error() {}, verbose() {}},
	};
	const logger = new TransactionLogger(plugin);
	const transfer = {transferId: "1:export_1", operationType: "transfer", status: "completed", platformName: "p", platformIndex: 3,
		forceName: "player", sourceInstanceId: 1, targetInstanceId: 2, startedAt: 1, exportId: "1:export_1", artifactSizeBytes: null,
		passengers: [{name: "alice", items: [{name: "power-armor", count: 1}]}]};
	for (const view of [logger.buildTransferInfo(transfer), logger.buildTransferSummary(transfer.transferId, transfer),
		logger.buildDetailedTransferSummary(transfer.transferId, transfer)]) {
		assert.equal(JSON.stringify(view).includes("alice"), false);
	}
});

const HARNESS_LINEAGE = require("./lineage-harness.cjs").HARNESS_LINEAGE;

function lineageHarness(onStep = () => undefined) {
	const order = [];
	const h = makeHarness(() => ({ success: true }), msg => {
		if (msg.constructor.name === "TransferStatusUpdate") return { success: true };
		const step = msg.action || msg.constructor.name;
		order.push(step);
		return onStep(step, msg) ?? (step === "GetSourceTransferLockStateRequest" ? { state: "pre_commit", transferId: msg.transferId } : { success: true });
	});
	const commit = h.plugin.lineageRegistry.commitTransfer.bind(h.plugin.lineageRegistry);
	h.plugin.lineageRegistry.commitTransfer = async value => { order.push("registry"); return commit(value); };
	return { ...h, order };
}

test("a lineage transfer commits the registry after the source deletion acknowledgement and before activation", async () => {
	const h = lineageHarness();
	const result = await h.orch.transferPlatform("1:lineage", 2);
	const transfer = onlyTransfer(h.activeTransfers);
	clearTimeout(transfer.validationTimeout);
	assert.deepEqual([h.calls.pendingPersisted.lineage, h.calls.pendingPersisted.lineageGeneration], [HARNESS_LINEAGE, 0],
		"the recovery intent does not carry the lineage");
	await h.orch.handleTransferValidation({ transferId: result.transferId, success: true });
	assert.deepEqual(h.order, ["verify", "DeleteSourcePlatformRequest", "registry", "go_live"]);
	assert.equal(transfer.status, "completed");
	const saved = h.plugin.lineageRegistry.get(HARNESS_LINEAGE);
	assert.deepEqual([saved.instanceId, saved.generation, saved.lastExportId, saved.source], [2, 1, result.transferId, "transfer"]);
});

test("the destination import carries the lineage only through the controller transfer envelope", async () => {
	const imports = [];
	const h = makeHarness(msg => { imports.push(msg.toJSON().exportData); return { success: true }; });
	await h.orch.transferPlatform("1:envelope", 2);
	clearTimeout(onlyTransfer(h.activeTransfers).validationTimeout);
	assert.deepEqual([imports[0]._lineage, imports[0]._lineageGeneration], [HARNESS_LINEAGE, 0]);
});

test("an export without a lineage is refused before anything is imported", async () => {
	for (const exportData of [{ platform: { force: "player" } }, { lineage: "1:15", generation: 0 }, { lineage: HARNESS_LINEAGE, generation: -1 }]) {
		const h = makeHarness(() => assert.fail("an unlineaged export reached the destination"));
		h.plugin.platformStorage.get = () => ({ exportData, platformName: "p", platformIndex: 3, instanceId: 1, size: 1 });
		const result = await h.orch.transferPlatform("1:legacy-export", 2);
		assert.equal(result.success, false);
		assert.equal(result.safeToUnlockSource, true, "the untouched source must be released");
		assert.match(result.error, /no platform lineage/);
		assert.equal(h.activeTransfers.size, 0);
	}
});

for (const [name, hold, expected] of [
	["a hold without a lineage", {}, /disagree/],
	["a hold with another lineage", { lineage: "lineage:other:3", generation: 1 }, /does not match/],
	["a hold at the wrong generation", { lineage: HARNESS_LINEAGE, generation: 2 }, /does not match/],
]) {
	test(`${name} rolls back before the source is deleted`, async () => {
		const h = lineageHarness(step => step === "verify" ? { success: true, lineage: null, ...hold } : undefined);
		const result = await h.orch.transferPlatform("1:mismatch", 2);
		clearTimeout(onlyTransfer(h.activeTransfers).validationTimeout);
		await h.orch.handleTransferValidation({ transferId: result.transferId, success: true });
		const transfer = onlyTransfer(h.activeTransfers);
		assert.equal(transfer.status, "failed", "a definitely undeleted source was left locked with its destination held");
		assert.match(transfer.error, expected);
		assert.deepEqual(h.order, ["verify", "GetSourceTransferLockStateRequest", "discard"], "the source was deleted for a mismatched destination");
		assert.equal(h.calls.unlockRouteTaken, 1, "the source was not unlocked after the destination was discarded");
		assert.equal(h.calls.pendingRemoved, result.transferId);
		assert.equal(h.plugin.lineageRegistry.get(HARNESS_LINEAGE), undefined);
	});
}

test("a destination that already holds any copy of the lineage is refused before anything is exported or imported", async () => {
	for (const [answer, expected] of [[{ state: "present" }, /resolve the quarantined copy first/], [{ state: "unknown", reason: "Presence request timed out" }, /could not confirm.*timed out/]]) {
		const h = makeHarness(() => assert.fail("a transfer reached a destination that holds another copy"));
		h.calls.presence = () => answer;
		const result = await h.orch.transferPlatform("1:return-trip", 2);
		assert.equal(result.success, false);
		assert.equal(result.safeToUnlockSource, true, "the untouched source must be released");
		assert.match(result.error, expected);
		assert.deepEqual(h.calls.presenceChecks, [[2, HARNESS_LINEAGE]], "presence was not asked of the destination");
		assert.equal(h.activeTransfers.size, 0);
	}
});

test("a resolution snapshot is never transferred and its source stays locked", async () => {
	const h = makeHarness(() => assert.fail("a resolution snapshot reached the destination"));
	h.plugin.platformStorage.get = () => ({ exportData: withLineage({ platform: { force: "player" }, purpose: "resolution" }),
		platformName: "p", platformIndex: 3, instanceId: 1, size: 1 });
	const result = await h.orch.transferPlatform("1:resolution-snapshot", 2);
	assert.equal(result.success, false);
	assert.equal(result.safeToUnlockSource, false, "a transfer refusal unlocked a copy under resolution");
	assert.match(result.error, /resolution snapshot/);
	assert.equal(h.activeTransfers.size, 0);
});

test("a sectioned resolution snapshot keeps its purpose and is never transferred", async () => {
	const payload = deflateSync(JSON.stringify(withLineage({ platform: { force: "player" }, entities: [{ id: 1 }], purpose: "resolution" }))).toString("base64");
	const sectioned = await prepareSectionImport({ compressed: true, payload });
	assert.equal(sectioned.section_codec, 1);
	const exportData = await normalizeSectionExport(sectioned);
	assert.equal(exportData.purpose, "resolution", "the sectioned codec dropped the resolution purpose");
	const h = makeHarness(() => assert.fail("a sectioned resolution snapshot reached the destination"));
	h.plugin.platformStorage.get = () => ({ exportData, platformName: "p", platformIndex: 3, instanceId: 1, size: 1 });
	const result = await h.orch.transferPlatform("1:sectioned-snapshot", 2);
	assert.equal(result.success, false);
	assert.equal(result.safeToUnlockSource, false);
	assert.match(result.error, /resolution snapshot/);
	assert.equal(h.activeTransfers.size, 0);
});

test("a destination that reports another local copy at verify rolls back before the source is deleted", async () => {
	const h = lineageHarness(step => step === "verify" ? { success: true, lineage: HARNESS_LINEAGE, generation: 1, localCopy: true } : undefined);
	const result = await h.orch.transferPlatform("1:local-copy", 2);
	clearTimeout(onlyTransfer(h.activeTransfers).validationTimeout);
	await h.orch.handleTransferValidation({ transferId: result.transferId, success: true });
	const transfer = onlyTransfer(h.activeTransfers);
	assert.equal(transfer.status, "failed");
	assert.match(transfer.error, /another copy of this platform/);
	assert.deepEqual(h.order, ["verify", "GetSourceTransferLockStateRequest", "discard"], "the source was deleted although the destination holds another copy");
	assert.equal(h.calls.unlockRouteTaken, 1);
	assert.equal(h.plugin.lineageRegistry.get(HARNESS_LINEAGE), undefined);
});

test("mixed plugin versions: an old destination without lineage support rolls back cleanly", async () => {
	const h = lineageHarness(step => step === "verify" ? { success: true, lineage: null } : undefined);
	const result = await h.orch.transferPlatform("1:old-destination", 2);
	clearTimeout(onlyTransfer(h.activeTransfers).validationTimeout);
	await h.orch.handleTransferValidation({ transferId: result.transferId, success: true });
	assert.equal(onlyTransfer(h.activeTransfers).status, "failed");
	assert.deepEqual(h.order, ["verify", "GetSourceTransferLockStateRequest", "discard"]);
	assert.equal(h.calls.unlockRouteTaken, 1);
});

test("a registry that already records another holder rolls back before deletion", async () => {
	const h = lineageHarness();
	await h.plugin.lineageRegistry.update(draft => draft.set(HARNESS_LINEAGE, { instanceId: 9, generation: 0, platformName: "p",
		forceName: "player", lastExportId: null, updatedAt: 1, source: "claim" }));
	const result = await h.orch.transferPlatform("1:held-elsewhere", 2);
	clearTimeout(onlyTransfer(h.activeTransfers).validationTimeout);
	await h.orch.handleTransferValidation({ transferId: result.transferId, success: true });
	assert.equal(onlyTransfer(h.activeTransfers).status, "failed");
	assert.match(onlyTransfer(h.activeTransfers).error, /registry refused/);
	assert.deepEqual(h.order, ["verify", "GetSourceTransferLockStateRequest", "discard"]);
	assert.equal(h.calls.unlockRouteTaken, 1);
	assert.equal(h.plugin.lineageRegistry.get(HARNESS_LINEAGE).instanceId, 9);
});

for (const [name, reply] of [["a committed source", { state: "committed" }], ["a deleted source", { state: "source_gone_matching_transfer" }],
	["an unknown source", { state: "unknown/offline", error: "offline" }]]) {
	test(`a pre-delete refusal against ${name} keeps both copies protected instead of rolling back`, async () => {
		const h = lineageHarness(step => step === "verify" ? { success: true, lineage: null }
			: step === "GetSourceTransferLockStateRequest" ? reply : undefined);
		const result = await h.orch.transferPlatform("1:not-provable", 2);
		clearTimeout(onlyTransfer(h.activeTransfers).validationTimeout);
		await h.orch.handleTransferValidation({ transferId: result.transferId, success: true });
		const transfer = onlyTransfer(h.activeTransfers);
		assert.equal(transfer.status, "cleanup_failed");
		assert.match(transfer.error, /not provably undeleted/);
		assert.deepEqual(h.order, ["verify", "GetSourceTransferLockStateRequest"], "a destination was discarded while its source may be gone");
		assert.equal(h.calls.unlockRouteTaken, 0);
		assert.equal(h.calls.pendingRemoved, undefined);
	});
}

test("a refused discard during pre-delete rollback keeps both copies protected", async () => {
	const h = lineageHarness(step => step === "verify" ? { success: true, lineage: null } : step === "discard" ? { success: false, error: "evacuation failed" } : undefined);
	const result = await h.orch.transferPlatform("1:discard-refused", 2);
	clearTimeout(onlyTransfer(h.activeTransfers).validationTimeout);
	await h.orch.handleTransferValidation({ transferId: result.transferId, success: true });
	assert.equal(onlyTransfer(h.activeTransfers).status, "cleanup_failed");
	assert.match(onlyTransfer(h.activeTransfers).error, /discard not confirmed/);
	assert.equal(h.calls.unlockRouteTaken, 0, "the source was unlocked while the destination copy survived");
});

test("a registry write that fails after deletion keeps the hold and the intent, and recovery finishes the commit", async () => {
	const h = lineageHarness();
	let failCommit = true;
	const commit = h.plugin.lineageRegistry.commitTransfer;
	h.plugin.lineageRegistry.commitTransfer = async value => {
		if (failCommit) { h.order.push("registry-failed"); throw new Error("disk full"); }
		return commit(value);
	};
	const result = await h.orch.transferPlatform("1:write-fails", 2);
	const transfer = onlyTransfer(h.activeTransfers);
	clearTimeout(transfer.validationTimeout);
	await h.orch.handleTransferValidation({ transferId: result.transferId, success: true });
	assert.equal(transfer.status, "cleanup_failed");
	assert.match(transfer.error, /Source deleted; lineage registry not updated: .*disk full/);
	assert.deepEqual(h.order, ["verify", "DeleteSourcePlatformRequest", "registry-failed"], "the destination went live without a registry commit");
	assert.equal(h.calls.pendingRemoved, undefined, "the recovery intent was dropped");
	failCommit = false;
	h.plugin.pendingTransfers = new Map([[result.transferId, h.calls.pendingPersisted]]);
	await h.orch.recoverPendingTransfers();
	assert.equal(transfer.status, "completed");
	assert.deepEqual(h.order.slice(3), ["verify", "DeleteSourcePlatformRequest", "registry", "go_live"]);
	assert.equal(h.plugin.lineageRegistry.get(HARNESS_LINEAGE).generation, 1);
	assert.equal(h.calls.importSends, 1, "recovery repeated the import");
});

test("a lost activation reply retries the idempotent commit without advancing the generation twice", async () => {
	let lose = true;
	const h = lineageHarness(step => {
		if (step === "go_live" && lose) { lose = false; throw sessionLost(); }
		return undefined;
	});
	const result = await h.orch.transferPlatform("1:activation-lost", 2);
	const transfer = onlyTransfer(h.activeTransfers);
	clearTimeout(transfer.validationTimeout);
	await h.orch.handleTransferValidation({ transferId: result.transferId, success: true });
	assert.equal(transfer.status, "cleanup_failed");
	h.plugin.pendingTransfers = new Map([[result.transferId, h.calls.pendingPersisted]]);
	await h.orch.recoverPendingTransfers();
	assert.equal(transfer.status, "completed");
	const saved = h.plugin.lineageRegistry.get(HARNESS_LINEAGE);
	assert.deepEqual([saved.instanceId, saved.generation], [2, 1]);
});

test("recovery restores the lineage from the persisted intent, and a legacy intent commits without the registry", async () => {
	for (const legacy of [false, true]) {
		const h = lineageHarness(step => step === "verify" && legacy ? { success: true, lineage: null } : undefined);
		const intent = { transferId: "1:recovered", sourceExportId: "recovered", sourceInstanceId: 1, targetInstanceId: 2,
			sourcePlatformIndex: 3, sourcePlatformName: "p", forceName: "player", startedAt: 1, exportId: "1:recovered",
			...(legacy ? {} : { lineage: HARNESS_LINEAGE, lineageGeneration: 0 }) };
		h.plugin.pendingTransfers = new Map([[intent.transferId, intent]]);
		h.plugin.persistedTransactionLogs = [];
		await h.orch.recoverPendingTransfers();
		const transfer = onlyTransfer(h.activeTransfers);
		assert.equal(transfer.status, "completed", legacy ? "legacy" : "lineage");
		assert.deepEqual(h.order, legacy ? ["verify", "DeleteSourcePlatformRequest", "go_live"]
			: ["verify", "DeleteSourcePlatformRequest", "registry", "go_live"]);
		assert.equal(h.plugin.lineageRegistry.get(HARNESS_LINEAGE)?.generation, legacy ? undefined : 1);
	}
});

function rollbackHarness({ lockState = () => ({ state: "pre_commit" }), gate = () => ({ success: false, error: "No destination hold for transfer_id" }) } = {}) {
	const sends = [];
	const h = makeHarness(() => { throw sessionLost("Session Closed"); }, msg => {
		const name = msg.constructor.name;
		sends.push(name === "DestinationTransferGateRequest" ? `gate:${msg.action}` : name);
		if (name === "GetSourceTransferLockStateRequest") return lockState(msg);
		if (name === "DestinationTransferGateRequest") return gate(msg);
		if (name === "UnlockSourcePlatformRequest") return { success: false, error: "Platform no longer exists" };
		return { success: true };
	});
	h.sends = sends;
	h.plugin.pendingTransfers = new Map();
	h.plugin.transactionLogs = new Map();
	h.plugin.persistPendingTransfer = intent => { h.plugin.pendingTransfers.set(intent.transferId, intent); h.calls.pendingPersisted = intent; };
	h.plugin.removePendingTransfer = id => { h.plugin.pendingTransfers.delete(id); h.calls.pendingRemoved = id; };
	h.plugin.controller.instances = { get: id => ({ id, isDeleted: false }) };
	h.orch.tryUnlockSource = async (_id, transfer) => {
		h.calls.unlockRouteTaken++;
		transfer.sourceRollback = "failed";
		return "Unlock refused: captured belt cargo could not be put back (belt missing); protection retained";
	};
	return h;
}

const ROLLBACK_INTENT = { transferId: "1:job_225", sourceExportId: "job_225", sourceInstanceId: 1, targetInstanceId: 2,
	sourcePlatformIndex: 196, sourcePlatformName: "belt-roundtrip", forceName: "player", startedAt: 1, exportId: "1:job_225" };

function failedPrior(overrides = {}) {
	return { transferId: ROLLBACK_INTENT.transferId, savedAt: 2,
		transferInfo: { status: "failed", sourceInstanceId: 1, targetInstanceId: 2, platformIndex: 196, sourceRollback: "failed",
			error: "TEST: forced validation failure; Unlock refused: captured belt cargo could not be put back (belt missing); protection retained",
			...overrides.transferInfo },
		summary: { validation: { success: false, mismatchDetails: "TEST: forced validation failure" }, ...overrides.summary },
		events: overrides.events ?? [
			{ eventType: "validation_failed", message: "Validation failed: TEST: forced validation failure", validation: { mismatchDetails: "TEST: forced validation failure" } },
			{ eventType: "rollback_attempt", message: "Unlocking source platform" },
			{ eventType: "rollback_failed", message: "Unlock failed" },
			{ eventType: "transfer_failed", message: "Transfer failed" },
		] };
}

const destructiveSends = h => h.sends.filter(s => s === "gate:go_live" || s === "gate:discard" || s === "DeleteSourcePlatformRequest" || s === "UnlockSourcePlatformRequest");

test("a refused source unlock keeps the intent as rollbackPending; recovery retries the unlock and never the destination gate", async t => {
	const h = rollbackHarness();
	t.after(() => h.orch.stop());
	const res = await h.orch.transferPlatform("1:export_1", 2);
	const transfer = onlyTransfer(h.activeTransfers);
	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);
	assert.ok(h.plugin.pendingTransfers.has(res.transferId), "the recovery intent was persisted on awaiting_validation");
	await h.orch.handleTransferValidation({ transferId: res.transferId, success: false, validation: { mismatchDetails: "item mismatch" } });
	assert.equal(transfer.status, "failed");
	assert.equal(h.calls.unlockRouteTaken, 1);
	assert.equal(h.plugin.pendingTransfers.get(res.transferId)?.rollbackPending, true, "the intent records that only the rollback is pending");
	assert.deepEqual([...new Set(h.orch.requestQueue.hooks.busyInstances())].sort(), [1, 2], "both instances stay reserved while the rollback is pending");
	h.sends.length = 0;
	await h.orch.recoverPendingTransfers();
	assert.equal(h.calls.unlockRouteTaken, 2, "recovery retried the unlock");
	assert.ok(h.plugin.pendingTransfers.has(res.transferId), "a refused retry keeps the intent");
	assert.equal(transfer.status, "failed");
	assert.match(String(transfer.jobObservation?.reason), /Unlock refused/);
	assert.deepEqual(h.sends, ["GetSourceTransferLockStateRequest"], "a recorded validation failure queries the source; it never reaches the destination gate or the source delete");
	await h.orch.recoverPendingTransfers();
	assert.equal(h.calls.unlockRouteTaken, 2, "an immediate second tick backs off instead of hammering the source");
	h.orch.rollbackRetries.clear();
	h.orch.tryUnlockSource = async (_id, current) => { h.calls.unlockRouteTaken++; current.sourceRollback = "succeeded"; return null; };
	await h.orch.recoverPendingTransfers();
	assert.equal(h.calls.unlockRouteTaken, 3);
	assert.equal(h.calls.pendingRemoved, res.transferId, "the intent is released once the source is unlocked");
	assert.equal(h.plugin.pendingTransfers.size, 0);
	assert.equal(transfer.status, "failed");
	assert.equal(transfer.error, "item mismatch", "the stale unlock refusal leaves the failure reason once the source is released");
	assert.equal(transfer.jobObservation, undefined);
	assert.deepEqual(h.orch.requestQueue.hooks.busyInstances(), [], "the instance reservation is released with the intent");
	assert.deepEqual(destructiveSends(h), []);
});

test("after a restart, a legacy failed intent is recovered from the source lock state and keeps its prior events", async t => {
	const h = rollbackHarness({ lockState: () => ({ state: "unlocked" }) });
	t.after(() => h.orch.stop());
	h.plugin.pendingTransfers.set(ROLLBACK_INTENT.transferId, { ...ROLLBACK_INTENT });
	h.plugin.persistedTransactionLogs = [failedPrior()];
	await h.orch.recoverPendingTransfers();
	const transfer = onlyTransfer(h.activeTransfers);
	assert.deepEqual(h.sends, ["GetSourceTransferLockStateRequest"], "only the source lock state is queried: no verify, no unlock, no delete");
	assert.equal(h.calls.unlockRouteTaken, 0, "an already unlocked source is not unlocked again");
	assert.equal(transfer.status, "failed");
	assert.equal(transfer.sourceRollback, "released");
	assert.equal(transfer.error, "TEST: forced validation failure");
	assert.ok(h.calls.events.includes("rollback_resolved"));
	assert.equal(h.calls.pendingRemoved, ROLLBACK_INTENT.transferId);
	assert.deepEqual(h.plugin.transactionLogs.get(ROLLBACK_INTENT.transferId).map(event => event.eventType),
		["validation_failed", "rollback_attempt", "rollback_failed", "transfer_failed"], "the recreated record keeps the original evidence");
});

for (const [label, lockState, clears] of [
	["the platform was deleted by hand", { state: "source_missing", error: null }, false],
	["the platform is gone but its uncommitted lock remains", { state: "source_missing", error: "uncommitted transfer lock retained for a missing platform" }, true],
]) {
	test(`a cleanup_failed record left by the misrouted verify settles as failed when ${label}`, async t => {
		const h = rollbackHarness({ lockState: () => lockState });
		t.after(() => h.orch.stop());
		h.plugin.pendingTransfers.set(ROLLBACK_INTENT.transferId, { ...ROLLBACK_INTENT });
		h.plugin.persistedTransactionLogs = [failedPrior({
			transferInfo: { status: "cleanup_failed", sourceRollback: undefined, error: "Destination hold not confirmed: No destination hold for transfer_id 1:job_225" },
			events: [{ eventType: "cleanup_failed", message: "Destination hold not confirmed: No destination hold for transfer_id 1:job_225" }],
		})];
		await h.orch.recoverPendingTransfers();
		const transfer = onlyTransfer(h.activeTransfers);
		assert.deepEqual(h.sends.filter(s => s.startsWith("gate:")), [], "the destination gate is not asked again");
		assert.equal(h.sends.filter(s => s === "UnlockSourcePlatformRequest").length, clears ? 1 : 0, "a retained dangling lock is cleared once, best effort");
		assert.equal(h.calls.unlockRouteTaken, 0);
		assert.equal(transfer.status, "failed", "the misrouted cleanup_failed label is corrected once the source is resolved");
		assert.equal(transfer.error, "TEST: forced validation failure");
		assert.equal(transfer.sourceRollback, "released");
		assert.ok(h.calls.events.includes("rollback_resolved"));
		assert.equal(h.calls.pendingRemoved, ROLLBACK_INTENT.transferId);
	});
}

test("a rollback whose destination discard failed keeps cleanup_failed after its source is released", async t => {
	const h = rollbackHarness({ lockState: () => ({ state: "unlocked" }) });
	t.after(() => h.orch.stop());
	h.plugin.pendingTransfers.set(ROLLBACK_INTENT.transferId, { ...ROLLBACK_INTENT, rollbackPending: true });
	h.plugin.persistedTransactionLogs = [failedPrior({ transferInfo: { status: "cleanup_failed" },
		summary: { validation: { success: false, mismatchDetails: "TEST: forced validation failure", cleanup_failed: true, cleanup_error: "GameUtils.delete_platform failed: returned false" } } })];
	await h.orch.recoverPendingTransfers();
	const transfer = onlyTransfer(h.activeTransfers);
	assert.equal(transfer.status, "cleanup_failed", "an orphan destination copy stays visible");
	assert.equal(transfer.error, "TEST: forced validation failure; GameUtils.delete_platform failed: returned false");
	assert.equal(h.calls.pendingRemoved, ROLLBACK_INTENT.transferId, "the source side is resolved even though the destination orphan remains");
});

for (const state of ["committed", "source_gone_matching_transfer"]) {
	test(`a rollback intent whose source reports ${state} is never released and is flagged once`, async t => {
		const h = rollbackHarness({ lockState: () => ({ state }) });
		t.after(() => h.orch.stop());
		h.plugin.pendingTransfers.set(ROLLBACK_INTENT.transferId, { ...ROLLBACK_INTENT, rollbackPending: true });
		h.plugin.persistedTransactionLogs = [failedPrior()];
		await h.orch.recoverPendingTransfers();
		const transfer = onlyTransfer(h.activeTransfers);
		assert.equal(transfer.status, "cleanup_failed");
		assert.match(String(transfer.error), /inspect both servers/);
		assert.equal(h.calls.unlockRouteTaken, 0);
		assert.equal(h.calls.pendingRemoved, undefined);
		assert.equal(h.calls.events.filter(e => e === "cleanup_failed").length, 1);
		await h.orch.recoverPendingTransfers();
		assert.equal(h.calls.events.filter(e => e === "cleanup_failed").length, 1, "repeated ticks do not re-log the same contradiction");
		assert.equal(h.calls.pendingRemoved, undefined);
		assert.deepEqual(h.sends.filter(s => s.startsWith("gate:")), [], "a contradiction never asks the destination");
		assert.deepEqual(destructiveSends(h), []);
	});
}

test("an identity mismatch or an unavailable source keeps the intent and never touches the source lock", async t => {
	let reply = () => ({ state: "identity_mismatch", error: "platform identity mismatch" });
	const h = rollbackHarness({ lockState: () => reply() });
	t.after(() => h.orch.stop());
	h.plugin.pendingTransfers.set(ROLLBACK_INTENT.transferId, { ...ROLLBACK_INTENT, rollbackPending: true });
	h.plugin.persistedTransactionLogs = [failedPrior()];
	await h.orch.recoverPendingTransfers();
	const transfer = onlyTransfer(h.activeTransfers);
	assert.equal(transfer.status, "failed");
	assert.match(String(transfer.jobObservation?.reason), /release-rollback/);
	reply = () => { throw new Error("Session Closed"); };
	await h.orch.recoverPendingTransfers();
	assert.match(String(transfer.jobObservation?.reason), /unavailable/);
	assert.equal(h.calls.unlockRouteTaken, 0);
	assert.equal(h.calls.pendingRemoved, undefined);
	assert.deepEqual(h.sends.filter(s => s !== "GetSourceTransferLockStateRequest"), []);
});

test("an intent with a recorded success verdict still follows the destination gate, not the rollback path", async t => {
	const h = rollbackHarness({ gate: () => ({ success: false, error: "hold unavailable" }) });
	t.after(() => h.orch.stop());
	h.plugin.pendingTransfers.set(ROLLBACK_INTENT.transferId, { ...ROLLBACK_INTENT });
	h.plugin.persistedTransactionLogs = [{ transferId: ROLLBACK_INTENT.transferId, savedAt: 2,
		transferInfo: { status: "cleanup_failed", sourceInstanceId: 1, targetInstanceId: 2, platformIndex: 196, error: "Source deletion not confirmed; destination remains held: timeout" },
		summary: { validation: { success: true, itemCountMatch: true, fluidCountMatch: true } },
		events: [{ eventType: "validation_received", message: "Validation: SUCCESS" }, { eventType: "cleanup_failed", message: "Source deletion not confirmed" }] }];
	await h.orch.recoverPendingTransfers();
	const transfer = onlyTransfer(h.activeTransfers);
	assert.deepEqual(h.sends, ["gate:verify"], "the success path verifies the destination first and asks nothing of the source");
	assert.equal(transfer.status, "cleanup_failed");
	assert.equal(h.calls.unlockRouteTaken, 0);
	assert.equal(h.calls.pendingRemoved, undefined);
	assert.ok(!h.calls.events.includes("rollback_resolved"));
});

test("release-rollback refuses everything it cannot verify and releases only a verified source", async t => {
	const states = { source: { state: "identity_mismatch", error: "transfer id mismatch" }, gate: { success: false, error: "No destination hold" } };
	const h = rollbackHarness({ lockState: () => states.source, gate: () => states.gate });
	t.after(() => h.orch.stop());
	const id = ROLLBACK_INTENT.transferId;
	assert.match(String((await h.orch.releaseRollback("1:nobody", "admin")).error), /Unknown transfer/);
	h.plugin.persistedTransactionLogs = [failedPrior()];
	assert.equal((await h.orch.releaseRollback(id, "admin")).outcome, "nothing_pending");
	h.plugin.pendingTransfers.set(id, { ...ROLLBACK_INTENT });
	h.plugin.persistedTransactionLogs = [failedPrior({ transferInfo: { status: "awaiting_validation", sourceRollback: undefined }, summary: { validation: null }, events: [] })];
	h.activeTransfers.set(id, { transferId: id, operationType: "transfer", status: "awaiting_validation", sourceInstanceId: 1, targetInstanceId: 2, platformIndex: 196, forceName: "player" });
	assert.match(String((await h.orch.releaseRollback(id, "admin")).error), /still being observed/);
	h.activeTransfers.clear();
	h.plugin.persistedTransactionLogs = [{ transferId: id, savedAt: 2, transferInfo: { status: "cleanup_failed", sourceInstanceId: 1, targetInstanceId: 2, platformIndex: 196 },
		summary: { validation: { success: true } }, events: [] }];
	assert.match(String((await h.orch.releaseRollback(id, "admin")).error), /no recorded validation failure/);
	h.plugin.persistedTransactionLogs = [failedPrior()];
	h.plugin.pendingTransfers.set(id, { ...ROLLBACK_INTENT, rollbackPending: true });
	for (const [state, pattern] of [["pre_commit", /still holds/], ["committed", /inspect both servers/], ["source_gone_matching_transfer", /inspect both servers/], ["unknown/offline", /unavailable/]]) {
		states.source = { state, error: null };
		const refused = await h.orch.releaseRollback(id, "admin");
		assert.equal(refused.success, false, state);
		assert.match(String(refused.error), pattern, state);
		assert.ok(h.plugin.pendingTransfers.has(id), `${state} keeps the intent`);
	}
	states.source = { state: "identity_mismatch", error: "transfer id mismatch" };
	h.calls.offlineInstances = new Set([1]);
	assert.match(String((await h.orch.releaseRollback(id, "admin")).error), /offline/);
	h.calls.offlineInstances = undefined;
	states.gate = { success: true };
	assert.match(String((await h.orch.releaseRollback(id, "admin")).error), /destination still confirms a hold/);
	states.gate = { success: false, error: "No destination hold" };
	assert.equal(h.calls.unlockRouteTaken, 0, "release never unlocks by itself");
	assert.deepEqual(h.sends.filter(s => s === "DeleteSourcePlatformRequest" || s === "UnlockSourcePlatformRequest"), []);
	assert.ok(h.plugin.pendingTransfers.has(id));
	const released = await h.orch.releaseRollback(id, "admin");
	assert.deepEqual(released, { success: true, transferId: id, outcome: "released", status: "failed", sourceState: "identity_mismatch", operator: "admin",
		contradiction: null, acknowledged: false });
	const transfer = h.activeTransfers.get(id);
	assert.equal(transfer.sourceRollback, "released");
	assert.equal(transfer.error, "TEST: forced validation failure");
	assert.ok(h.calls.events.includes("rollback_released"));
	assert.equal(h.plugin.pendingTransfers.has(id), false);
	assert.equal((await h.orch.releaseRollback(id, "admin")).outcome, "nothing_pending", "a retry after a lost reply is harmless");
	h.plugin.pendingTransfers.set(id, { ...ROLLBACK_INTENT, rollbackPending: true });
	h.plugin.controller.instances = { get: () => undefined };
	h.sends.length = 0;
	const gone = await h.orch.releaseRollback(id, "operator-2");
	assert.equal(gone.success, true);
	assert.equal(gone.sourceState, "instance_deleted");
	assert.deepEqual(h.sends.filter(s => s === "GetSourceTransferLockStateRequest"), [], "a source deleted from the cluster is not queried");
	assert.equal(h.plugin.pendingTransfers.has(id), false);
});

test("a stale awaiting_validation copy restored from the queue journal cannot override rollbackPending, even with a verifiable hold", async t => {
	const h = rollbackHarness({ lockState: () => ({ state: "pre_commit" }), gate: () => ({ success: true }) });
	t.after(() => h.orch.stop());
	const id = ROLLBACK_INTENT.transferId;
	h.plugin.pendingTransfers.set(id, { ...ROLLBACK_INTENT, rollbackPending: true });
	h.plugin.persistedTransactionLogs = [failedPrior()];
	const stale = { transferId: id, operationType: "transfer", status: "awaiting_validation", awaitingLateVerdict: true, timingPendingRecovery: true,
		sourceInstanceId: 1, targetInstanceId: 2, platformIndex: 196, forceName: "player", platformName: "belt-roundtrip", startedAt: 1 };
	h.activeTransfers.set(id, stale);
	h.orch.tryUnlockSource = async (_id, current) => { h.calls.unlockRouteTaken++; current.sourceRollback = "succeeded"; return null; };
	await h.orch.recoverPendingTransfers();
	assert.deepEqual(h.sends, ["GetSourceTransferLockStateRequest"], "the durable marker wins over the stale status: no verify, no delete, no activation");
	assert.equal(h.calls.unlockRouteTaken, 1);
	assert.equal(stale.status, "failed");
	assert.equal(stale.awaitingLateVerdict, false);
	assert.equal(stale.timingPendingRecovery, false);
	assert.equal(h.calls.pendingRemoved, id);
	assert.deepEqual(h.plugin.transactionLogs.get(id).map(event => event.eventType),
		["validation_failed", "rollback_attempt", "rollback_failed", "transfer_failed"], "prior events are seeded even when no record was recreated");
});

test("the queue interruption hook does not resurrect a rollback-pending record", async t => {
	const h = rollbackHarness();
	t.after(() => h.orch.stop());
	const id = ROLLBACK_INTENT.transferId;
	h.plugin.pendingTransfers.set(id, { ...ROLLBACK_INTENT, rollbackPending: true });
	h.plugin.persistedTransactionLogs = [failedPrior({ transferInfo: { timingPendingRecovery: true } })];
	const entry = () => ({ id: "request:stale", request: { sourceInstanceId: 1, sourcePlatformIndex: 196, targetInstanceId: 2 },
		operation: { transferId: id, operationType: "transfer", status: "awaiting_validation", sourceInstanceId: 1, targetInstanceId: 2, platformIndex: 196, forceName: "player" } });
	await h.orch.requestQueue.hooks.interrupted(entry());
	assert.equal(h.activeTransfers.has(id), false, "the stale journal copy must not become the active record");
	assert.equal(h.orch.requestQueue.entries.has("request:stale"), false);
	h.plugin.pendingTransfers.set(id, { ...ROLLBACK_INTENT });
	await h.orch.requestQueue.hooks.interrupted(entry());
	assert.equal(h.activeTransfers.has(id), false, "persisted rollback evidence with a terminal status is decisive even without the marker");
	h.plugin.persistedTransactionLogs = [{ transferId: id, savedAt: 2,
		transferInfo: { status: "cleanup_failed", timingPendingRecovery: true, sourceInstanceId: 1, targetInstanceId: 2, platformIndex: 196 },
		summary: { validation: { success: true } }, events: [{ eventType: "validation_received", message: "Validation: SUCCESS" }] }];
	await h.orch.requestQueue.hooks.interrupted(entry());
	assert.equal(h.activeTransfers.has(id), true, "without rollback evidence the hook keeps its retention behaviour for the success path");
});

for (const [label, later, expected] of [
	["the source keeps answering with its retirement record", { state: "source_gone_matching_transfer", error: "source retirement journal records this transfer" }, "source_gone_matching_transfer"],
	["the deletion receipt has aged out and the source answers source_missing", { state: "source_missing", error: null }, "committed"],
]) {
	test(`a committed or deleted source is a sticky contradiction when ${label}: never auto-released, refused without acknowledgement, released with it as cleanup_failed`, async t => {
		let state = { state: "committed", error: null };
		const h = rollbackHarness({ lockState: () => state });
		t.after(() => h.orch.stop());
		const id = ROLLBACK_INTENT.transferId;
		h.plugin.pendingTransfers.set(id, { ...ROLLBACK_INTENT, rollbackPending: true });
		h.plugin.persistedTransactionLogs = [failedPrior()];
		await h.orch.recoverPendingTransfers();
		const transfer = onlyTransfer(h.activeTransfers);
		assert.equal(transfer.status, "cleanup_failed");
		assert.equal(h.plugin.pendingTransfers.get(id)?.rollbackContradiction?.state, "committed", "the contradiction is persisted on the intent");
		state = later;
		h.sends.length = 0;
		await h.orch.recoverPendingTransfers();
		assert.deepEqual(h.sends, [], "a contradicted intent is not re-queried or released by recovery");
		assert.equal(transfer.status, "cleanup_failed");
		assert.equal(h.plugin.pendingTransfers.has(id), true);
		assert.ok(!h.calls.events.includes("rollback_resolved"));
		const refused = await h.orch.releaseRollback(id, "admin");
		assert.equal(refused.success, false, "a plain release must not clear a contradiction");
		assert.match(String(refused.error), /acknowledge-contradiction/);
		assert.equal(h.plugin.pendingTransfers.has(id), true);
		const released = await h.orch.releaseRollback(id, "admin", true);
		assert.equal(released.success, true);
		assert.equal(released.status, "cleanup_failed", "an acknowledged release keeps the contradiction visible");
		assert.equal(released.contradiction, expected);
		assert.equal(released.acknowledged, true);
		assert.match(String(transfer.error), /inspect both servers/);
		assert.equal(transfer.sourceRollback, "released");
		assert.equal(h.plugin.pendingTransfers.has(id), false);
		assert.deepEqual(destructiveSends(h), []);
	});
}

test("a legacy intent without the marker but with terminal rollback evidence is decided on every path", async t => {
	let lockState = { state: "unlocked", error: null };
	const h = rollbackHarness({ lockState: () => lockState, gate: () => ({ success: true }) });
	t.after(() => h.orch.stop());
	const id = ROLLBACK_INTENT.transferId;
	h.plugin.pendingTransfers.set(id, { ...ROLLBACK_INTENT });
	h.plugin.persistedTransactionLogs = [failedPrior({ transferInfo: { timingPendingRecovery: true } })];
	await h.orch.requestQueue.hooks.interrupted({ id: "request:legacy", request: { sourceInstanceId: 1, sourcePlatformIndex: 196, targetInstanceId: 2 },
		operation: { transferId: id, operationType: "transfer", status: "awaiting_validation", sourceInstanceId: 1, targetInstanceId: 2, platformIndex: 196, forceName: "player" } });
	assert.equal(h.activeTransfers.has(id), false, "the journal hook must not resurrect a record whose persisted evidence records a rollback");
	const stale = { transferId: id, operationType: "transfer", status: "awaiting_validation", awaitingLateVerdict: true, timingPendingRecovery: true,
		sourceInstanceId: 1, targetInstanceId: 2, platformIndex: 196, forceName: "player", platformName: "belt-roundtrip", startedAt: 1 };
	h.activeTransfers.set(id, stale);
	assert.deepEqual(await h.orch.handleValidationSuccess(id, stale), { sourceResolved: false });
	assert.deepEqual(h.sends, [], "the success path is refused for a legacy rollback intent before any destination request");
	assert.equal(h.calls.events.filter(e => e === "rollback_guard").length, 1);
	h.plugin.transactionLogs.set(id, [{ eventType: "rollback_guard" }]);
	await h.orch.handleValidationSuccess(id, stale);
	assert.equal(h.calls.events.filter(e => e === "rollback_guard").length, 1, "the guard event is not repeated while it is the latest event");
	h.plugin.transactionLogs.delete(id);
	await h.orch.recoverPendingTransfers();
	assert.deepEqual(h.sends, ["GetSourceTransferLockStateRequest"], "recovery follows the recorded rollback even though the in-memory copy is job-pending");
	assert.equal(stale.status, "failed");
	assert.equal(h.calls.pendingRemoved, id);
});

test("a late SUCCESS verdict's cleanup_failed is not downgraded when the source is later released", async t => {
	const h = rollbackHarness({ lockState: () => ({ state: "unlocked" }) });
	t.after(() => h.orch.stop());
	const id = ROLLBACK_INTENT.transferId;
	h.plugin.pendingTransfers.set(id, { ...ROLLBACK_INTENT, rollbackPending: true });
	h.plugin.persistedTransactionLogs = [failedPrior({
		transferInfo: { status: "cleanup_failed", error: "TEST: forced validation failure; Unlock refused: x; late import SUCCESS after rollback: verify destination cleanup before retrying" },
		events: [
			{ eventType: "validation_failed", message: "Validation failed: TEST: forced validation failure", validation: { mismatchDetails: "TEST: forced validation failure" } },
			{ eventType: "rollback_failed", message: "Unlock failed" },
			{ eventType: "validation_after_settle", message: "Late validation SUCCESS arrived after this transfer settled", settledStatus: "failed", newStatus: "cleanup_failed" },
		] })];
	await h.orch.recoverPendingTransfers();
	const transfer = onlyTransfer(h.activeTransfers);
	assert.equal(h.calls.pendingRemoved, id, "the source side is released");
	assert.equal(transfer.status, "cleanup_failed", "the destination may still hold a copy; the warning label stays");
	assert.match(String(transfer.error), /late import SUCCESS/);
	assert.equal(transfer.sourceRollback, "released");
});

for (const [label, intent, prior] of [
	["the intent marker alone", { ...ROLLBACK_INTENT, rollbackPending: true }, failedPrior({ transferInfo: { sourceRollback: undefined }, summary: { validation: null }, events: [] })],
	["rollback events alone", { ...ROLLBACK_INTENT }, failedPrior({ transferInfo: { sourceRollback: undefined }, summary: { validation: null }, events: [{ eventType: "validation_failed", message: "Validation failed: x" }] })],
	["a recorded sourceRollback alone", { ...ROLLBACK_INTENT }, failedPrior({ summary: { validation: null }, events: [] })],
	["a recorded validation failure alone", { ...ROLLBACK_INTENT }, failedPrior({ transferInfo: { sourceRollback: undefined }, events: [] })],
]) {
	test(`the rollback classifier accepts ${label}`, async t => {
		const h = rollbackHarness({ lockState: () => ({ state: "unlocked" }) });
		t.after(() => h.orch.stop());
		h.plugin.pendingTransfers.set(ROLLBACK_INTENT.transferId, intent);
		h.plugin.persistedTransactionLogs = [prior];
		await h.orch.recoverPendingTransfers();
		assert.deepEqual(h.sends, ["GetSourceTransferLockStateRequest"], label);
		assert.equal(h.calls.pendingRemoved, ROLLBACK_INTENT.transferId, label);
	});
}

test("the rollback classifier rejects a record with none of the evidence", async t => {
	const h = rollbackHarness({ gate: () => ({ success: false, error: "hold unavailable" }) });
	t.after(() => h.orch.stop());
	h.plugin.pendingTransfers.set(ROLLBACK_INTENT.transferId, { ...ROLLBACK_INTENT });
	h.plugin.persistedTransactionLogs = [failedPrior({ transferInfo: { sourceRollback: undefined, status: "cleanup_failed" }, summary: { validation: null }, events: [] })];
	await h.orch.recoverPendingTransfers();
	assert.deepEqual(h.sends, ["gate:verify"]);
	assert.equal(h.calls.pendingRemoved, undefined);
});

test("handleValidationSuccess refuses a transfer whose intent records a rollback", async t => {
	const h = rollbackHarness({ gate: () => ({ success: true }) });
	t.after(() => h.orch.stop());
	const id = ROLLBACK_INTENT.transferId;
	h.plugin.pendingTransfers.set(id, { ...ROLLBACK_INTENT, rollbackPending: true });
	const transfer = { transferId: id, operationType: "transfer", status: "awaiting_validation", sourceInstanceId: 1, targetInstanceId: 2, platformIndex: 196, forceName: "player", platformName: "p" };
	h.activeTransfers.set(id, transfer);
	assert.deepEqual(await h.orch.handleValidationSuccess(id, transfer), { sourceResolved: false });
	assert.deepEqual(h.sends, [], "no verify, no delete, no activation");
});

test("a refused unlock clears the admission-recovery flag; a failed destination discard keeps it", async t => {
	for (const discardFailed of [false, true]) {
		const h = rollbackHarness();
		t.after(() => h.orch.stop());
		const res = await h.orch.transferPlatform("1:export_1", 2);
		const transfer = onlyTransfer(h.activeTransfers);
		if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);
		transfer.timingPendingRecovery = true;
		await h.orch.handleTransferValidation({ transferId: res.transferId, success: false,
			validation: { mismatchDetails: "item mismatch", ...(discardFailed ? { cleanup_failed: true, cleanup_error: "delete refused" } : {}) } });
		assert.equal(transfer.timingPendingRecovery, discardFailed, `discardFailed=${discardFailed}`);
		assert.equal(transfer.status, discardFailed ? "cleanup_failed" : "failed");
		assert.equal(h.plugin.pendingTransfers.get(res.transferId)?.rollbackPending, true);
	}
});

test("concurrent release calls release once", async t => {
	const h = rollbackHarness({ lockState: () => ({ state: "unlocked" }) });
	t.after(() => h.orch.stop());
	const id = ROLLBACK_INTENT.transferId;
	h.plugin.pendingTransfers.set(id, { ...ROLLBACK_INTENT, rollbackPending: true });
	h.plugin.persistedTransactionLogs = [failedPrior()];
	const [first, second] = await Promise.all([h.orch.releaseRollback(id, "a"), h.orch.releaseRollback(id, "b")]);
	assert.deepEqual([first.outcome, second.outcome].sort(), ["nothing_pending", "released"]);
	assert.equal(h.calls.events.filter(e => e === "rollback_released").length, 1);
});
