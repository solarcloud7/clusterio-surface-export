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
		platformTree: { resolveInstanceName: (id) => `instance-${id}` },
		subscriptions: { emitLogUpdate() {} },
		logger,
	};
	return { txLogger: new TransactionLogger(plugin), plugin, errors, transferId };
}

test("transaction write-back preserves a corrupt on-disk history", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-export-history-"));
	const file = path.join(dir, "transactions.json");
	const corruptBytes = "{not valid json\n";
	fs.writeFileSync(file, corruptBytes);
	const { txLogger, errors, transferId } = makeTransactionHarness(file);

	await txLogger.persistTransactionLog(transferId);

	assert.equal(fs.readFileSync(file, "utf8"), corruptBytes);
	const message = errors.join("\n");
	assert.match(message, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(message, /unreadable/);
	assert.match(message, /skipping this write/);
	assert.match(message, /repair or move the file aside/i);
	assert.match(message, /restart/);
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
