"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
	if (request === "@clusterio/lib") {
		return {
			escapeString: (value) => String(value),
			safeOutputFile: async (file, data) => fs.writeFileSync(file, data),
			wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
			Counter: class {},
			Histogram: class {},
		};
	}
	if (request === "@clusterio/controller") {
		return { BaseControllerPlugin: class {} };
	}
	return originalLoad.call(this, request, parent, isMain);
};

const distNode = path.join(__dirname, "..", "dist", "node");
const { ControllerPlugin } = require(path.join(distNode, "controller.js"));
const { TransactionLogger } = require(path.join(distNode, "lib", "transaction-logger.js"));

function loggerSpy() {
	const errors = [];
	return {
		errors,
		logger: {
			error: (message) => errors.push(message),
			info() {},
			verbose() {},
			warn() {},
		},
	};
}

function makeTransactionHarness(file) {
	const { logger, errors } = loggerSpy();
	const transferId = "1:001_read_failure";
	const transfer = {
		transferId,
		operationType: "transfer",
		platformName: "test-platform",
		platformIndex: 3,
		forceName: "player",
		sourceInstanceId: 1,
		targetInstanceId: 2,
		status: "completed",
	};
	const plugin = {
		transactionLogPath: file,
		transactionLogs: new Map([[transferId, []]]),
		persistedTransactionLogs: [{ transferId: "memory-entry" }],
		activeTransfers: new Map([[transferId, transfer]]),
		platformStorage: new Map(),
		// Latched by loadTransactionLogs; persistTransactionLog refuses while it is set.
		transactionLogLoadError: null,
		// pruneTransactionLogsMap consults the ledger to tell "finished" from "evicted from
		// activeTransfers while still in flight" — absence there does not mean resolved.
		auditIndex: new Map(),
		auditRevisions: new Map(),
		// The detail write is preceded by a ledger append, so the fake records rows rather than
		// discarding them — ordering is a property worth being able to assert.
		auditRows: [],
		recordAuditRow: async function (row) { this.auditRows.push(row); },
		// No config here => retention keeps everything, which is the safe default for an
		// un-migrated controller.
		controller: { config: undefined },
		platformTree: { resolveInstanceName: (id) => `instance-${id}` },
		subscriptions: { emitLogUpdate() {} },
		logger,
	};
	return { txLogger: new TransactionLogger(plugin), plugin, errors, transferId };
}

test("transaction write-back preserves a corrupt on-disk history", async () => {
	// The invariant is unchanged — a corrupt history is never overwritten, and the operator is told
	// why — but the MECHANISM moved. It used to be a full re-read before every write (7.62 MB and
	// 17 ms to detect corruption, then discard the parse). It is now latched at the BOOT load, so the
	// gate has to be armed the way production arms it: by loading first.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-export-history-"));
	const file = path.join(dir, "transactions.json");
	const corruptBytes = "{not valid json\n";
	fs.writeFileSync(file, corruptBytes);
	const { txLogger, plugin, errors, transferId } = makeTransactionHarness(file);

	await txLogger.loadTransactionLogs();
	assert.ok(plugin.transactionLogLoadError, "the boot load must latch the failure");
	errors.length = 0; // isolate the write-path message from the load-path one

	await txLogger.persistTransactionLog(transferId);

	assert.equal(fs.readFileSync(file, "utf8"), corruptBytes, "the corrupt file must not be overwritten");
	const message = errors.join("\n");
	assert.match(message, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(message, /startup load failed/);
	assert.match(message, /preserved as-is/);
	assert.match(message, /repair or move the file aside/i);
	assert.match(message, /restart/);
	// New, and the reason the trade is acceptable at all: a damaged detail store no longer loses the
	// record that a transfer happened, only its timeline.
	assert.match(message, /audit ledger/i);
});

test("a CLEAN boot load leaves the write path open", async () => {
	// The other half of the gate, and the one a too-eager check would break: latching on a load that
	// succeeded would silently stop all persistence. Fails if the gate keys on anything but a real
	// load failure.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-export-history-"));
	const file = path.join(dir, "transactions.json");
	fs.writeFileSync(file, "[]");
	const { txLogger, plugin, transferId } = makeTransactionHarness(file);

	await txLogger.loadTransactionLogs();
	assert.equal(plugin.transactionLogLoadError, null);

	await txLogger.persistTransactionLog(transferId);

	const written = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.equal(written.length, 1, "the write must go through after a clean load");
	assert.equal(written[0].transferId, transferId);
});

test("an ABSENT history is not a failure — first boot must still persist", async () => {
	// ENOENT is the ordinary first-run case, not corruption. Treating it as a load failure would mean
	// a brand-new controller never wrote a transaction log at all.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-export-history-"));
	const file = path.join(dir, "transactions.json");
	const { txLogger, plugin, transferId } = makeTransactionHarness(file);

	await txLogger.loadTransactionLogs();
	assert.equal(plugin.transactionLogLoadError, null, "a missing file is not a corrupt one");

	await txLogger.persistTransactionLog(transferId);
	assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).length, 1);
});

test("transaction load failure keeps the history already served from memory", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-export-history-"));
	const file = path.join(dir, "transactions.json");
	fs.writeFileSync(file, "{not valid json\n");
	const { txLogger, plugin, errors } = makeTransactionHarness(file);
	const originalHistory = plugin.persistedTransactionLogs;

	await txLogger.loadTransactionLogs();

	assert.equal(plugin.persistedTransactionLogs, originalHistory);
	const message = errors.join("\n");
	assert.match(message, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(message, /file was left untouched/i);
	assert.match(message, /Transaction Logs tab will appear empty/);
	assert.match(message, /repair or move the file aside/i);
	assert.match(message, /restart/);
});

test("degraded platform-storage load refuses to overwrite the unreadable file", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-export-storage-"));
	const file = path.join(dir, "exports.json");
	const corruptBytes = "[{not valid json]\n";
	fs.writeFileSync(file, corruptBytes);
	const { logger, errors } = loggerSpy();
	const plugin = Object.create(ControllerPlugin.prototype);
	plugin.storagePath = file;
	plugin.platformStorage = new Map();
	plugin.logger = logger;

	await plugin.loadStorage();
	const originalLoadError = plugin.storageLoadError;
	assert.match(originalLoadError, /Expected property name or/);
	plugin.platformStorage.set("1:new", { exportId: "1:new", exportData: { important: true } });
	await plugin.persistStorage();

	assert.equal(fs.readFileSync(file, "utf8"), corruptBytes);
	const messages = errors.join("\n");
	assert.match(messages, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(messages, /Persistence is DISABLED for this session/);
	assert.match(messages, /back up/);
	assert.match(messages, /repair or move the file aside/i);
	assert.match(messages, /exports created while degraded will NOT survive a restart/);
	assert.ok(messages.includes(`startup load failed (${originalLoadError})`));
	assert.match(messages, /This session's changes will not survive restart/);
});
