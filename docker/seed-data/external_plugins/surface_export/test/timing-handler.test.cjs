const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { ControllerPlugin } = require("../dist/node/controller");
const { OperationTimingEvent } = require("../dist/node/messages");

test("the registered timing handler returns a Promise and persists evidence without transfer side effects", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "timing-handler-"));
	const handlers = new Map(), warnings = [];
	const plugin = Object.create(ControllerPlugin.prototype);
	Object.assign(plugin, { logger: { info() {}, verbose() {}, warn: x => warnings.push(x), error: x => warnings.push(x) },
		controller: { config: { get: key => key === "controller.database_directory" ? dir : 100 },
			instances: new Map(), handle: (type, handler) => handlers.set(type, handler) } });
	try {
		await plugin.init();
		plugin.txLogger.scheduleTimingWrite = () => {}; // flush explicitly below, avoiding a timer race
		const handler = handlers.get(OperationTimingEvent);
		assert.equal(typeof handler, "function");
		const active = { transferId: "op", status: "transporting", startedAt: Date.now(), sourceInstanceId: 1, targetInstanceId: 2 };
		plugin.activeTransfers.set("op", active);
		plugin.transactionLogs.set("op", []);
		const event = { record: { v: 1, id: "entities", clockId: "2:boot:job", jobId: "job", operationId: "op",
			instanceId: 2, owner: "destination-lua", stage: "entities", kind: "execution", status: "completed", revision: 2,
			startMs: 1, endMs: 4, executionMs: 2 } };
		const result = handler(event);
		assert.equal(typeof result?.catch, "function", "Clusterio dispatch calls .catch on event handlers");
		await result; await handler(event);
		assert.equal(active.timing.records.length, 1);
		await plugin.txLogger.persistTransactionLog("op", false);
		const [saved] = JSON.parse(await fs.readFile(plugin.transactionLogPath, "utf8"));
		assert.equal(saved.summary.timing.records.length, 1);
		assert.equal(saved.transferInfo.status, "transporting");
		assert.equal(plugin.auditIndex.size, 0);
		plugin.txLogger.acceptTiming = () => { throw new Error("telemetry sink unavailable"); };
		await assert.rejects(handler(event), /telemetry sink unavailable/);
		assert.equal(plugin.activeTransfers.get("op"), active);
		assert.equal(active.status, "transporting");
		assert.equal(plugin.pendingTransfers.size, 0);
		assert.equal(plugin.sourceCommitMarkers.size, 0);
	} finally {
		plugin.subscriptions?.treeBroadcastLimiter.cancel();
		await fs.rm(dir, { recursive: true, force: true });
	}
});
