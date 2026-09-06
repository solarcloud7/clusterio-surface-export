const { test } = require("node:test");
const assert = require("node:assert/strict");
const { TransactionLogger } = require("../dist/node/lib/transaction-logger");
const { TimingClock } = require("../dist/node/lib/timing");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const record = (overrides = {}) => ({ v: 1, id: "entities", clockId: "2:boot:job", jobId: "job", operationId: "op",
	instanceId: 2, owner: "destination-lua", stage: "entities", kind: "execution", status: "completed", revision: 2,
	startMs: 1, endMs: 4, executionMs: 2, ...overrides });
function harness() {
	const warnings = [], writes = [];
	const plugin = { activeTransfers: new Map(), platformStorage: new Map(), persistedTransactionLogs: [],
		logger: { warn: value => warnings.push(value) } };
	const logger = new TransactionLogger(plugin);
	logger.scheduleTimingWrite = id => writes.push(id);
	return { plugin, logger, warnings, writes };
}
test("late timing enriches retained terminal details without reopening an operation", () => {
	const { plugin, logger, writes } = harness();
	const entry = { transferId: "op", transferInfo: { status: "completed" }, summary: {} };
	plugin.persistedTransactionLogs.push(entry);
	logger.acceptTiming(record()); logger.acceptTiming(record());
	logger.acceptTiming(record({ revision: 1, status: "running", endMs: null }));
	assert.equal(entry.summary.timing.records.length, 1); assert.equal(entry.transferInfo.status, "completed");
	assert.equal(plugin.activeTransfers.size, 0); assert.equal(writes.length, 1);
});
test("early export evidence is retained with its stored artifact and reused later", () => {
	const { plugin, logger } = harness();
	const early = record({ operationId: undefined, exportId: "source-job", owner: "source-lua" });
	logger.acceptTiming(early);
	const stored = { exportId: "2:source-job", sourceExportId: "source-job", instanceId: 2 };
	plugin.platformStorage.set(stored.exportId, stored); logger.captureStoredTiming(stored);
	assert.equal(logger.pendingTiming.size, 0); assert.equal(stored.timing.records.length, 1);
	const operation = { transferId: "op", exportId: stored.exportId, sourceInstanceId: 2, status: "transporting" };
	plugin.activeTransfers.set("op", operation);
	logger.acceptTiming(record({ id: "other" }));
	assert.equal(operation.timing.records.length, 2); assert.equal(operation.status, "transporting");
});
test("instance restart interrupts retained open records without fabricating a finish", () => {
	const { plugin, logger } = harness();
	const entry = { transferId: "op", transferInfo: { status: "completed" }, summary: { timing: { v: 1,
		records: [record({ status: "running", revision: 1, endMs: null, executionMs: null })] } } };
	plugin.persistedTransactionLogs.push(entry);
	logger.acceptTiming(record({ stage: "runtime_started" }));
	assert.equal(entry.summary.timing.records[0].status, "interrupted");
	assert.equal(entry.summary.timing.records[0].endMs, null);
	logger.acceptTiming(record()); // a genuine late finish can still complete its own old clock
	assert.equal(entry.summary.timing.records[0].status, "completed");
});
test("expired unmatched records are discarded with an explicit diagnostic", () => {
	const { logger, warnings } = harness();
	logger.acceptTiming(record());
	for (const value of logger.pendingTiming.values()) value.received -= 300001;
	logger.acceptTiming(record({ id: "new" }));
	assert.equal(logger.pendingTiming.size, 1); assert.equal(warnings.length, 1);
	logger.acceptTiming(null); assert.equal(warnings.length, 2);
});

test("retrying a failed canonical ID starts a separate clock without contaminating the prior attempt", () => {
	const { plugin, logger } = harness();
	const previous = { transferId: "op", status: "transporting" };
	plugin.activeTransfers.set("op", previous);
	const first = logger.beginObservation("op");
	previous.status = "failed";
	logger.getObservedDuration(previous);
	const priorCount = previous.timing.records.length;
	const second = logger.beginObservation("op");
	assert.notEqual(first.clockId, second.clockId);
	assert.equal(previous.timing.records.length, priorCount);
	const retry = { transferId: "op", status: "transporting" };
	plugin.activeTransfers.set("op", retry);
	logger.collectTiming(retry);
	assert.ok(retry.timing.records.every(row => row.clockId === second.clockId));
	retry.status = "completed";
	assert.equal(typeof logger.getObservedDuration(retry), "number");
	assert.equal(previous.status, "failed");
});

test("timing-only persistence cannot write a terminal audit row for an in-flight transfer", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "timing-test-"));
	try {
		const { plugin, logger } = harness(); let audits = 0;
		Object.assign(plugin, { transactionLogPath: path.join(dir, "details.json"), transactionLogs: new Map([["op", []]]),
			transactionLogLoadError: null, auditIndex: new Map(), recordAuditRow: async () => { audits++; },
			platformTree: { resolveInstanceName: () => "test" }, controller: { config: { get: () => 10 } } });
		plugin.logger.error = message => assert.fail(message);
		plugin.activeTransfers.set("op", { transferId: "op", status: "transporting", startedAt: Date.now(), sourceInstanceId: 1, targetInstanceId: 2 });
		logger.acceptTiming(record());
		await logger.persistTransactionLog("op", false);
		assert.equal(audits, 0);
		assert.equal(JSON.parse(await fs.readFile(plugin.transactionLogPath, "utf8"))[0].transferInfo.status, "transporting");
	} finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("an import failure keeps the headline open through its required rollback acknowledgement", () => {
	const { logger } = harness(); let now = 0;
	const clock = new TimingClock("op", "controller", () => {}, () => now);
	logger.clocks.set("op", clock); logger.spans.set("op:operation", clock.start("Observed operation"));
	const operation = { transferId: "op", status: "failed", timingPendingRecovery: true };
	now = 12; logger.finishObservation(operation); assert.equal(operation.observedDurationMs, undefined);
	now = 47; operation.timingPendingRecovery = false; logger.finishObservation(operation);
	assert.equal(operation.observedDurationMs, 47);
	now = 200; logger.finishObservation(operation); assert.equal(operation.observedDurationMs, 47);
});

test("controller reload preserves missing boundaries and still accepts a genuine late Lua finish", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "timing-test-"));
	try {
		const { plugin, logger } = harness(); plugin.logger.info = () => {};
		plugin.transactionLogPath = path.join(dir, "details.json");
		const entry = { transferId: "op", transferInfo: { status: "completed" }, summary: { timing: { v: 1,
			records: [record({ revision: 1, status: "running", endMs: null, executionMs: null })] } } };
		await fs.writeFile(plugin.transactionLogPath, JSON.stringify([entry]));
		await logger.loadTransactionLogs();
		assert.equal(plugin.persistedTransactionLogs[0].summary.timing.records[0].status, "interrupted");
		assert.equal(plugin.persistedTransactionLogs[0].summary.timing.records[0].endMs, null);
		logger.acceptTiming(record());
		assert.equal(plugin.persistedTransactionLogs[0].summary.timing.records[0].status, "completed");
		assert.equal(plugin.activeTransfers.size, 0);
	} finally {
		assert.ok(dir.startsWith(path.join(os.tmpdir(), "timing-test-")));
		await fs.rm(dir, { recursive: true, force: true });
	}
});
