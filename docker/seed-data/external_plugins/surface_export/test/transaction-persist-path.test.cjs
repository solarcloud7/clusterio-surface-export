"use strict";


const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const trace = [];
beforeEach(() => { trace.length = 0; });

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

after(() => { Module._load = originalLoad; });

const distNode = path.join(__dirname, "..", "dist", "node");
const { TransactionLogger } = require(path.join(distNode, "lib", "transaction-logger.js"));

const warnings = [];
beforeEach(() => { warnings.length = 0; });

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
		auditIndex: new Map(),
		auditRevisions: new Map(),
		auditRows: [],
		recordAuditRow: async function (row) { trace.push("ledger"); this.auditRows.push(row); },
		controller: {
			config: detailCap === undefined
				? undefined
				: { get: (key) => (key.endsWith("transaction_log_detail_entries") ? detailCap : undefined) },
		},
		platformTree: { resolveInstanceName: (id) => `instance-${id}` },
		subscriptions: { emitLogUpdate() {} },
		logger: { error() {}, info() {}, verbose() {}, warn: (m) => warnings.push(m) },
	};
	return { txLogger: new TransactionLogger(plugin), plugin, transferId, file };
}

test("the ledger row is written BEFORE the detail entry", async () => {
	const { txLogger, transferId } = makeHarness();

	await txLogger.persistTransactionLog(transferId);

	assert.deepEqual(trace, ["ledger", "detail"]);
});

test("the persisted entry snapshots its events instead of aliasing the live array", async () => {
	const { txLogger, plugin, transferId } = makeHarness();

	await txLogger.persistTransactionLog(transferId);
	const persistedLength = plugin.persistedTransactionLogs[0].events.length;

	plugin.transactionLogs.get(transferId).push({ timestampMs: 2_000, eventType: "later", message: "z" });

	assert.equal(plugin.persistedTransactionLogs[0].events.length, persistedLength,
		"a later event must not mutate an entry that was already written");
});

test("the transactionLogs Map is pruned to what is still reachable", async () => {
	const { txLogger, plugin, transferId } = makeHarness({ extraLogIds: ["1:900_gone", "1:901_gone"] });

	assert.equal(plugin.transactionLogs.size, 3);
	await txLogger.persistTransactionLog(transferId);

	assert.equal(plugin.transactionLogs.size, 1, "unreachable event arrays must be released");
	assert.ok(plugin.transactionLogs.has(transferId), "the live transfer must be kept");
});

test("retention trims the detail store on write", async () => {
	const { txLogger, plugin, transferId, file } = makeHarness({ detailCap: 10 });
	plugin.persistedTransactionLogs = Array.from({ length: 15 }, (_u, i) => ({
		transferId: `old-${i}`, savedAt: i + 1, events: [], transferInfo: { status: "completed" },
	}));

	await txLogger.persistTransactionLog(transferId);

	const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.equal(onDisk.length, 10, "the cap is enforced against what is actually written");
	assert.ok(onDisk.some(e => e.transferId === transferId), "the entry just written must be among them");
});

test("a cap below the allowed minimum is clamped and warned, NOT read as 'no cap'", async () => {
	const { txLogger, plugin, transferId, file } = makeHarness({ detailCap: 0 });
	plugin.persistedTransactionLogs = Array.from({ length: 40 }, (_u, i) => ({
		transferId: `old-${i}`, savedAt: i + 1, events: [], transferInfo: { status: "completed" },
	}));

	await txLogger.persistTransactionLog(transferId);

	assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).length, 10, "clamped to the minimum, not ignored");
	assert.ok(warnings.some(m => /transaction_log_detail_entries is 0/.test(m)),
		"an out-of-range cap must say so rather than be silently reinterpreted");
});

test("with no cap configured the store is not trimmed", async () => {
	const { txLogger, plugin, transferId, file } = makeHarness({ detailCap: undefined });
	plugin.persistedTransactionLogs = Array.from({ length: 40 }, (_u, i) => ({
		transferId: `old-${i}`, savedAt: i, events: [], transferInfo: { status: "completed" },
	}));

	await txLogger.persistTransactionLog(transferId);

	assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).length, 41);
});


test("two concurrent persists both survive — neither entry is lost", async () => {
	const { txLogger, plugin, file } = makeHarness();
	const second = "1:002_rival";
	plugin.transactionLogs.set(second, [{ timestampMs: 1_020, eventType: "transfer_created", message: "x" }]);
	plugin.activeTransfers.set(second, {
		transferId: second, operationType: "transfer", platformName: "pad-2", platformIndex: 4,
		forceName: "player", sourceInstanceId: 1, targetInstanceId: 2, status: "completed", startedAt: 1_000,
	});

	await Promise.all([
		txLogger.persistTransactionLog("1:001_subject"),
		txLogger.persistTransactionLog(second),
	]);

	const onDisk = JSON.parse(fs.readFileSync(file, "utf8")).map(e => e.transferId);
	assert.ok(onDisk.includes("1:001_subject"), "the first transfer's detail must be on disk");
	assert.ok(onDisk.includes(second), "and so must the second's — neither may be lost to the race");
});

test("an unresolved transfer keeps its events even when evicted from activeTransfers", async () => {
	const { txLogger, plugin, transferId } = makeHarness();
	const inFlight = "1:777_inflight";
	plugin.transactionLogs.set(inFlight, [{ timestampMs: 800, eventType: "transfer_created", message: "x" }]);
	plugin.auditIndex.set(inFlight, { transferId: inFlight, rowKind: "start", status: "awaiting_validation" });

	await txLogger.persistTransactionLog(transferId);

	assert.ok(plugin.transactionLogs.has(inFlight),
		"a transfer whose ledger row is still `start` has not resolved — its events must not be dropped");
});

test("a history file that parses but is not an array latches instead of being overwritten", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-export-persist-"));
	const file = path.join(dir, "transactions.json");
	const original = '{"transferId":"hand-edited"}\n';
	fs.writeFileSync(file, original);
	const { txLogger, plugin, transferId } = makeHarness();
	plugin.transactionLogPath = file;

	await txLogger.loadTransactionLogs();
	assert.ok(plugin.transactionLogLoadError, "a non-array history must latch the gate");

	await txLogger.persistTransactionLog(transferId);
	assert.equal(fs.readFileSync(file, "utf8"), original, "the original bytes must be preserved");
});

test("a detail entry with NO LEDGER ROW outranks a same-class sibling when the window trims", () => {
	const { txLogger, plugin } = makeHarness({ detailCap: 10 });

	const entries = [];
	for (let i = 0; i < 12; i += 1) {
		const transferId = `1:1${String(i).padStart(2, "0")}`;
		entries.push({
			transferId,
			savedAt: 1_000 + i,
			events: [],
			transferInfo: { status: "completed", startedAt: 1_000 + i },
		});
		if (i > 0) {
			plugin.auditIndex.set(transferId, { transferId, rowKind: "terminal" });
		}
	}

	const retained = txLogger.applyDetailRetention(entries);

	assert.equal(retained.length, 10, "the cap must still bind");
	assert.ok(retained.some(e => e.transferId === "1:100"),
		"the row-less entry must survive a sibling that still has its permanent row");
	assert.ok(!retained.some(e => e.transferId === "1:101"),
		"and it must have DISPLACED one — otherwise the cap simply fit everything and this proves nothing");
});


test("a recycled transferId archives the old record and starts the live id clean", async () => {
	const { txLogger, plugin, transferId } = makeHarness();

	await txLogger.persistTransactionLog(transferId);
	assert.equal(plugin.persistedTransactionLogs.length, 1);

	await txLogger.archiveRecycledTransferId(transferId, 9_999);

	const archived = plugin.persistedTransactionLogs[0];
	assert.match(archived.transferId, new RegExp(`^${transferId}@\\d+$`),
		"the old record must keep its history under a recognizable archival id");
	assert.equal(archived.transferInfo.transferId, archived.transferId,
		"the nested info must carry the archival id too, or id-based readers see a ghost");
	assert.ok(!plugin.transactionLogs.has(transferId),
		"stale in-memory events must go — logTransactionEvent reuses an existing array, so leaving "
		+ "them would MERGE two operations' event streams");
	assert.ok(plugin.auditRows.some(r => r.transferId === archived.transferId && r.rowKind === "terminal"),
		"the archived record needs a ledger row under its archival id — without one, retention's "
		+ "isPinned treats it as 'only surviving evidence' and keeps it FOREVER, and the list shows "
		+ "revisions:0 for an operation that recorded a verdict");

	plugin.activeTransfers.set(transferId, {
		transferId, operationType: "transfer", platformName: "pad", platformIndex: 3,
		forceName: "player", sourceInstanceId: 1, targetInstanceId: 2,
		status: "completed", startedAt: 9_999,
	});
	plugin.transactionLogs.set(transferId,
		[{ timestampMs: 10_000, eventType: "transfer_created", message: "new run" }]);
	await txLogger.persistTransactionLog(transferId);

	assert.equal(plugin.persistedTransactionLogs.length, 2, "two operations, two records");
	const last = plugin.persistedTransactionLogs[plugin.persistedTransactionLogs.length - 1];
	assert.equal(last.transferId, transferId, "the newest entry owns the live id — `latest` is honest again");
});

test("the same operation re-registering does NOT archive its own record", async () => {
	const { txLogger, plugin, transferId } = makeHarness();
	await txLogger.persistTransactionLog(transferId);

	await txLogger.archiveRecycledTransferId(transferId, 1_000);

	assert.equal(plugin.persistedTransactionLogs[0].transferId, transferId,
		"a matching startedAt is the same operation; its record must stay live");
});

test("both operation-registration sites archive before claiming the id (source contract)", () => {
	const sites = [["controller.ts", "controller"], [path.join("lib", "transfer-orchestrator.ts"), "orchestrator"]];
	for (const [file, label] of sites) {
		const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
		assert.match(source, /archiveRecycledTransferId\([^)]*\);\s*\n\s*this(?:\.plugin)?\.activeTransfers\.set\(/,
			`${label} must archive a recycled id immediately before registering the new operation`);
	}
});
