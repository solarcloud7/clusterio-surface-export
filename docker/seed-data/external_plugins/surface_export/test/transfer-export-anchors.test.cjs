"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const distNode = path.join(__dirname, "..", "dist", "node");
const { TransferOrchestrator } = require(path.join(distNode, "lib", "transfer-orchestrator.js"));
const messages = require(path.join(distNode, "messages.js"));

function makeHarness() {
	const noop = () => {};
	const activeTransfers = new Map();
	const events = [];
	const plugin = {
		logger: { error: noop, warn: noop, info: noop },
		persistPendingTransfer: noop,
		removePendingTransfer: noop,
		isInstanceOnline: () => true,
		persistStorage: async () => {},
		platformStorage: {
			get: () => ({
				exportData: { platform: { force: "player" } },
				exportMetrics: { instanceAsyncExportMs: 450, instanceAsyncExportTicks: 27 },
				platformName: "lab-transfer-fixture-v1",
				platformIndex: 5,
				instanceId: 1315067557,
				size: 113432,
			}),
			delete: noop,
		},
		platformTree: { resolveInstanceName: (id) => `instance-${id}` },
		activeTransfers,
		recordTransferStarted: async () => {},
		txLogger: {
			...require("./timing-harness.cjs").makeTimingHarness(),
			logTransactionEvent: (_id, type, _message, _data, atMs) => { events.push({ type, atMs: atMs ?? null }); },
			archiveRecycledTransferId() {},
			startPhase: noop,
			endPhase: () => 0,
			persistTransactionLog: async () => {},
			buildPhaseSummary: () => ({}),
		},
		subscriptions: { emitTransferUpdate: noop, queueTreeBroadcast: noop },
		controller: {
			sendTo: async () => { throw new Error("stop before import — anchors are logged earlier"); },
		},
	};
	const orch = new TransferOrchestrator(plugin, messages);
	orch.tryUnlockSource = async () => null;
	return { orch, events };
}

const T0 = 1788580853517;

test("queue handoff preserves measured wait and events under the canonical transfer ID", async () => {
	const { orch, events } = makeHarness();
	const canonical = "1315067557:queue-test", queuedId = "request:queue-test";
	const wait = { v: 1, id: "wait", jobId: queuedId, operationId: queuedId, clockId: "controller:test",
		owner: "controller", stage: "Transfer queue wait", kind: "wait", status: "completed", revision: 2,
		startMs: 1, endMs: 501, executionMs: null };
	const operation = { transferId: queuedId, startedAt: T0 - 500, status: "preparing", timing: { v: 1, records: [wait] } };
	orch.plugin.transactionLogs = new Map([[queuedId, [{ eventType: "transfer_queued", timestampMs: T0 - 500 }]]]);
	orch.plugin.persistedTransactionLogs = [];
	orch.plugin.activeTransfers.set(queuedId, operation);
	orch.requestQueue.entries.set(queuedId, { id: queuedId, operation, request: { sourceInstanceId: 1315067557, sourcePlatformIndex: 5, targetInstanceId: 382892492 } });
	orch.txLogger.bindObservation(queuedId, canonical);
	await require("../dist/node/lib/timing").timingContext.run(orch.txLogger.clock(canonical), () =>
		orch.transferPlatform(canonical, 382892492, { requestExportAndLockMs: 100 }, T0));
	const transferred = orch.plugin.activeTransfers.get(canonical);
	assert.equal(transferred.queuedRequestId, queuedId);
	assert.equal(transferred.startedAt, T0 - 500);
	assert.deepEqual(transferred.timing.records, [{ ...wait, operationId: canonical }]);
	assert.equal(orch.plugin.transactionLogs.get(canonical)[0].eventType, "transfer_queued");
	assert.equal(orch.plugin.activeTransfers.has(queuedId), false);
	assert.equal(events.find(event => event.type === "export_requested").atMs, T0, "Export offset excludes time spent waiting in queue");
});

test("export_requested / export_returned are logged before transfer_created, backdated to t0 and t0 + requestMs", async () => {
	const { orch, events } = makeHarness();
	try {
		await orch.transferPlatform("1315067557:074_lab-transfer-fixture-v1", 382892492, {
			requestExportAndLockMs: 28126, waitForControllerStoreMs: 1404, controllerExportPrepTotalMs: 29530,
		}, T0);
	} catch (error) {
		assert.match(String(error && error.message), /stop before import/, "only the deliberate import stop may throw");
	}
	const types = events.map(e => e.type);
	const iReq = types.indexOf("export_requested");
	const iRet = types.indexOf("export_returned");
	const iCreated = types.indexOf("transfer_created");
	assert.ok(iReq >= 0 && iRet >= 0 && iCreated >= 0, `all three events present, got: ${types.join(",")}`);
	assert.ok(iReq < iRet && iRet < iCreated, "anchors precede transfer_created in the log");
	assert.equal(events[iReq].atMs, T0, "export_requested is stamped at the request time");
	assert.equal(events[iRet].atMs, T0 + 28126, "export_returned is stamped at t0 + requestExportAndLockMs");
	assert.equal(events[iCreated].atMs, null, "transfer_created keeps its live timestamp");
});

test("MUTATION KILL: without requestExportAndLockMs no anchor events are fabricated", async () => {
	const { orch, events } = makeHarness();
	try {
		await orch.transferPlatform("1315067557:075_lab-transfer-fixture-v1", 382892492, null, null);
	} catch (error) {
		assert.match(String(error && error.message), /stop before import/);
	}
	const types = events.map(e => e.type);
	assert.equal(types.includes("export_requested"), false);
	assert.equal(types.includes("export_returned"), false);
	assert.ok(types.includes("transfer_created"));
});
