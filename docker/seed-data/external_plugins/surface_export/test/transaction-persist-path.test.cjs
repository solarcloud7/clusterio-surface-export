"use strict";

/**
 * Properties of the detail persist path that are invisible in the file it produces.
 *
 * Each of these was a real defect or a real hazard rather than a hypothetical:
 *  - the ledger row must be written BEFORE the detail entry, because retention can delete the detail
 *    and the ledger row is what survives;
 *  - the persisted entry must SNAPSHOT its events, because it used to store the live array the
 *    transactionLogs Map keeps pushing to;
 *  - the transactionLogs Map must be pruned, because nothing ever deleted from it.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** Shared ordering trace: the safeOutputFile stub and the ledger fake both append to it. */
const trace = [];

const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
	if (request === "@clusterio/lib") {
		return {
			escapeString: (value) => String(value),
			safeOutputFile: async (file, data) => { trace.push("detail"); fs.writeFileSync(file, data); },
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
const { TransactionLogger } = require(path.join(distNode, "lib", "transaction-logger.js"));

function makeHarness({ detailCap, extraLogIds = [] } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-export-persist-"));
	const file = path.join(dir, "transactions.json");
	const transferId = "1:001_subject";
	const transfer = {
		transferId,
		operationType: "transfer",
		platformName: "pad",
		platformIndex: 3,
		forceName: "player",
		sourceInstanceId: 1,
		targetInstanceId: 2,
		status: "completed",
		startedAt: 1_000,
	};
	const transactionLogs = new Map([[transferId, [{ timestampMs: 1_010, eventType: "transfer_created", message: "x" }]]]);
	for (const id of extraLogIds) {
		transactionLogs.set(id, [{ timestampMs: 900, eventType: "stale", message: "y" }]);
	}
	const plugin = {
		transactionLogPath: file,
		transactionLogs,
		persistedTransactionLogs: [],
		activeTransfers: new Map([[transferId, transfer]]),
		platformStorage: new Map(),
		transactionLogLoadError: null,
		auditRows: [],
		recordAuditRow: async function (row) { trace.push("ledger"); this.auditRows.push(row); },
		controller: {
			config: detailCap === undefined
				? undefined
				: { get: (key) => (key.endsWith("transaction_log_detail_entries") ? detailCap : undefined) },
		},
		platformTree: { resolveInstanceName: (id) => `instance-${id}` },
		subscriptions: { emitLogUpdate() {} },
		logger: { error() {}, info() {}, verbose() {}, warn() {} },
	};
	return { txLogger: new TransactionLogger(plugin), plugin, transferId, file };
}

test("the ledger row is written BEFORE the detail entry", async () => {
	// Ordering is the whole safety argument for retention: a detail entry may be deleted later, so it
	// must never exist without the ledger row that outlives it. Reversed, a crash between the two
	// would lose the record that the transfer happened at all — not merely its timeline.
	trace.length = 0;
	const { txLogger, transferId } = makeHarness();

	await txLogger.persistTransactionLog(transferId);

	assert.deepEqual(trace, ["ledger", "detail"]);
});

test("the persisted entry snapshots its events instead of aliasing the live array", async () => {
	// `events` is the same array the transactionLogs Map holds and logTransactionEvent keeps pushing
	// to. Stored by reference, the already-persisted entry kept growing in memory, so the in-memory
	// history disagreed with the bytes on disk for the same transfer.
	const { txLogger, plugin, transferId } = makeHarness();

	await txLogger.persistTransactionLog(transferId);
	const persistedLength = plugin.persistedTransactionLogs[0].events.length;

	plugin.transactionLogs.get(transferId).push({ timestampMs: 2_000, eventType: "later", message: "z" });

	assert.equal(plugin.persistedTransactionLogs[0].events.length, persistedLength,
		"a later event must not mutate an entry that was already written");
});

test("the transactionLogs Map is pruned to what is still reachable", async () => {
	// The Map was never pruned — one entry per transfer for the life of the process, each holding
	// every event. Anything neither live nor retained on disk can no longer be reached by any reader.
	const { txLogger, plugin, transferId } = makeHarness({ extraLogIds: ["1:900_gone", "1:901_gone"] });

	assert.equal(plugin.transactionLogs.size, 3);
	await txLogger.persistTransactionLog(transferId);

	assert.equal(plugin.transactionLogs.size, 1, "unreachable event arrays must be released");
	assert.ok(plugin.transactionLogs.has(transferId), "the live transfer must be kept");
});

test("retention trims the detail store on write", async () => {
	const { txLogger, plugin, transferId, file } = makeHarness({ detailCap: 2 });
	plugin.persistedTransactionLogs = [
		{ transferId: "old-1", savedAt: 1, events: [], transferInfo: { status: "completed" } },
		{ transferId: "old-2", savedAt: 2, events: [], transferInfo: { status: "completed" } },
		{ transferId: "old-3", savedAt: 3, events: [], transferInfo: { status: "completed" } },
	];

	await txLogger.persistTransactionLog(transferId);

	const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.equal(onDisk.length, 2, "the cap is enforced against what is actually written");
	assert.ok(onDisk.some(e => e.transferId === transferId), "the entry just written must be among them");
});

test("with no cap configured the store is not trimmed", async () => {
	// An un-migrated controller has no such config field. Deleting detail because a lookup returned
	// undefined would be the worst reading of a missing setting.
	const { txLogger, plugin, transferId, file } = makeHarness({ detailCap: undefined });
	plugin.persistedTransactionLogs = Array.from({ length: 40 }, (_u, i) => ({
		transferId: `old-${i}`, savedAt: i, events: [], transferInfo: { status: "completed" },
	}));

	await txLogger.persistTransactionLog(transferId);

	assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).length, 41);
});
