"use strict";


const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Module = require("node:module");
const originalLoad = Module._load;
class NoopMetric {
	labels() { return this; }
	inc() {}
	observe() {}
}
Module._load = function patchedLoad(request, parent, isMain) {
	if (request === "@clusterio/lib") {
		return {
			escapeString: (value) => String(value),
			safeOutputFile: async (file, data) => fs.writeFileSync(file, data),
			wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
			Counter: NoopMetric,
			Histogram: NoopMetric,
		};
	}
	if (request === "@clusterio/controller") {
		return { BaseControllerPlugin: class {} };
	}
	return originalLoad.call(this, request, parent, isMain);
};

const distNode = path.join(__dirname, "..", "dist", "node");
const { TransactionLogger } = require(path.join(distNode, "lib", "transaction-logger.js"));
const { buildAuditRow, foldAuditRows, countRevisions } = require(path.join(distNode, "lib", "audit-ledger.js"));

const ACTIVE_ID = "2:001_alpha";
const PERSISTED_ID = "2:002_beta";
const BOTH_ID = "2:003_gamma";

function makeLogger({ active = [], persisted = [], extraRows = [], dropLedgerRows = false } = {}) {
	const persistedEntries = persisted.map(entry => ({
		transferId: entry.transferId,
		savedAt: entry.startedAt || 2_000,
		events: [],
		transferInfo: {
			platformName: entry.platformName || "pad",
			operationType: "transfer",
			sourceInstanceId: 2,
			targetInstanceId: 1,
			status: entry.status || "completed",
			startedAt: entry.startedAt || 2_000,
		},
	}));
	const auditRows = dropLedgerRows ? [...extraRows] : [
		...persistedEntries.map(entry => buildAuditRow({
			transferId: entry.transferId,
			rowKind: "terminal",
			savedAt: entry.savedAt,
			eventCount: entry.events.length,
			lastEventAt: null,
			info: entry.transferInfo,
		})),
		...extraRows,
	];
	const plugin = {
		activeTransfers: new Map(active.map(entry => [entry.transferId, {
			platformName: entry.platformName || "pad",
			sourceInstanceId: 2,
			targetInstanceId: 1,
			status: entry.status || "completed",
			startedAt: entry.startedAt || 1_000,
			exportId: null,
		}])),
		persistedTransactionLogs: persistedEntries,
		auditIndex: foldAuditRows(auditRows),
		auditRevisions: countRevisions(auditRows),
		platformStorage: new Map(),
		transactionLogs: new Map(),
		platformTree: { resolveInstanceName: (id) => `instance-${id}` },
		logger: { info() {}, error() {}, warn() {} },
	};
	return new TransactionLogger(plugin);
}

const byId = (summaries) => new Map(summaries.map(s => [s.transferId, s]));

test("an in-memory transfer is stamped registrySource 'active'", () => {
	const summaries = makeLogger({ active: [{ transferId: ACTIVE_ID }] }).getTransferSummaries();
	assert.equal(byId(summaries).get(ACTIVE_ID).registrySource, "active",
		"an activeTransfers entry WILL refuse a same-ID retry — a caller must be able to see that");
});

test("a persisted-only transfer is stamped registrySource 'persisted'", () => {
	const summaries = makeLogger({ persisted: [{ transferId: PERSISTED_ID }] }).getTransferSummaries();
	assert.equal(byId(summaries).get(PERSISTED_ID).registrySource, "persisted",
		"the retry guard never reads the persisted log, so this ID is history, not a blocker — and a "
		+ "controller restart would NOT remove it");
});

test("an ID in BOTH stores is stamped 'active' — active wins, and that is the answer that matters", () => {
	const logger = makeLogger({
		active: [{ transferId: BOTH_ID, status: "completed" }],
		persisted: [{ transferId: BOTH_ID, status: "completed" }],
	});
	const summaries = logger.getTransferSummaries();
	assert.equal(summaries.filter(s => s.transferId === BOTH_ID).length, 1, "the merge must dedupe");
	assert.equal(byId(summaries).get(BOTH_ID).registrySource, "active",
		"if it is live it will refuse, regardless of also being on disk. Reporting 'persisted' here "
		+ "would tell an operator no action is needed while the run is about to be refused.");
});

test("the two branches are distinguishable in one merged result", () => {
	const logger = makeLogger({
		active: [{ transferId: ACTIVE_ID }],
		persisted: [{ transferId: PERSISTED_ID }],
	});
	const map = byId(logger.getTransferSummaries());
	assert.equal(map.size, 2);
	assert.notEqual(map.get(ACTIVE_ID).registrySource, map.get(PERSISTED_ID).registrySource);
});

test("registrySource does NOT ride on buildTransferSummary", () => {
	const logger = makeLogger();
	const built = logger.buildTransferSummary("2:004_delta", {
		platformName: "pad", sourceInstanceId: 2, targetInstanceId: 1,
		status: "completed", startedAt: 1_000, exportId: null,
	}, null);
	assert.equal(built.registrySource, undefined,
		"the stamp belongs to the merge, not to the per-transfer builder");
});

const LEDGER_ONLY_ID = "2:005_epsilon";

test("a transfer present ONLY in the audit ledger still appears in the list", () => {
	const row = buildAuditRow({
		transferId: LEDGER_ONLY_ID,
		rowKind: "terminal",
		savedAt: 5_000,
		eventCount: 4,
		lastEventAt: 5_100,
		info: {
			platformName: "evicted-pad",
			operationType: "transfer",
			sourceInstanceId: 2,
			targetInstanceId: 1,
			status: "completed",
			startedAt: 5_000,
		},
	});
	const summaries = makeLogger({ extraRows: [row] }).getTransferSummaries();
	const summary = byId(summaries).get(LEDGER_ONLY_ID);

	assert.ok(summary, "a transfer whose detail was evicted must still be listed");
	assert.equal(summary.platformName, "evicted-pad");
	assert.equal(summary.status, "completed");
	assert.equal(summary.registrySource, "persisted",
		"history, not a live blocker — the retry guard never reads the ledger");
});

test("a second terminal row is visible as a revision, not silently collapsed", () => {
	const base = {
		rowKind: "terminal",
		info: { platformName: "pad", operationType: "transfer", sourceInstanceId: 2, targetInstanceId: 1, startedAt: 6_000 },
	};
	const first = buildAuditRow({ ...base, transferId: "2:006_zeta", savedAt: 6_000, eventCount: 3, lastEventAt: 6_010,
		info: { ...base.info, status: "failed" } });
	const second = buildAuditRow({ ...base, transferId: "2:006_zeta", savedAt: 6_500, eventCount: 5, lastEventAt: 6_510,
		info: { ...base.info, status: "completed" } });

	const summaries = makeLogger({ extraRows: [first, second] }).getTransferSummaries();
	const summary = byId(summaries).get("2:006_zeta");

	assert.equal(summary.revisions, 2, "both verdicts must be counted");
	assert.equal(summary.status, "completed", "the later terminal row is the current one");
});

test("a terminal row is never buried by a start row that lands after it", () => {
	const shared = { transferId: "2:007_eta", info: { platformName: "pad", sourceInstanceId: 2, targetInstanceId: 1 } };
	const terminal = buildAuditRow({ ...shared, rowKind: "terminal", savedAt: 7_000, eventCount: 4, lastEventAt: 7_010,
		info: { ...shared.info, status: "completed", startedAt: 7_000 } });
	const lateStart = buildAuditRow({ ...shared, rowKind: "start", savedAt: 7_500, eventCount: 0, lastEventAt: null,
		info: { ...shared.info, status: "awaiting_validation", startedAt: 7_500 } });

	const summaries = makeLogger({ extraRows: [terminal, lateStart] }).getTransferSummaries();
	assert.equal(byId(summaries).get("2:007_eta").status, "completed",
		"a start row must never supersede a terminal one, whatever the file order");
});

test("a start-only transfer reports ZERO recorded verdicts, not one", () => {
	const started = buildAuditRow({
		transferId: "2:008_theta",
		rowKind: "start",
		savedAt: 8_000,
		eventCount: 1,
		lastEventAt: 8_010,
		info: { platformName: "pad", sourceInstanceId: 2, targetInstanceId: 1, status: "awaiting_validation", startedAt: 8_000 },
	});

	const summary = byId(makeLogger({ extraRows: [started] }).getTransferSummaries()).get("2:008_theta");

	assert.ok(summary, "an interrupted transfer must still be listed");
	assert.equal(summary.revisions, 0, "no terminal row means no verdict was ever recorded");
});


test("a transfer whose LEDGER ROW FAILED TO WRITE is still listed", () => {
	const summaries = makeLogger({
		persisted: [{ transferId: PERSISTED_ID, status: "completed" }],
		dropLedgerRows: true,
	}).getTransferSummaries();

	const summary = byId(summaries).get(PERSISTED_ID);
	assert.ok(summary, "the detail entry is the only surviving evidence — it must reach the list");
	assert.equal(summary.status, "completed", "and carry its real verdict, not a placeholder");
	assert.equal(summary.registrySource, "persisted",
		"still history rather than a live blocker: the retry guard reads neither store");
});

test("an EMPTY audit index falls back to the whole detail window", () => {
	const summaries = makeLogger({
		persisted: [
			{ transferId: "2:010_kappa", startedAt: 10_000 },
			{ transferId: "2:011_lambda", startedAt: 11_000 },
		],
		dropLedgerRows: true,
	}).getTransferSummaries();

	assert.deepEqual(summaries.map(s => s.transferId), ["2:011_lambda", "2:010_kappa"],
		"every retained detail entry must be listed, newest first");
});

test("the LEDGER still wins where the two disagree", () => {
	const ledgerRow = buildAuditRow({
		transferId: "2:012_mu",
		rowKind: "terminal",
		savedAt: 12_000,
		eventCount: 1,
		lastEventAt: 12_010,
		info: { platformName: "pad", sourceInstanceId: 2, targetInstanceId: 1, status: "completed", startedAt: 12_000 },
	});
	const summaries = makeLogger({
		persisted: [{ transferId: "2:012_mu", status: "failed", startedAt: 12_000 }],
		extraRows: [ledgerRow],
		dropLedgerRows: true,
	}).getTransferSummaries();

	assert.equal(summaries.filter(s => s.transferId === "2:012_mu").length, 1, "and must not duplicate");
	assert.equal(byId(summaries).get("2:012_mu").status, "completed",
		"the ledger row is the permanent record; the detail entry only fills gaps it leaves");
});

test("a LEDGER-ONLY transfer — trimmed out of the detail window — is still listed", () => {
	const trimmed = buildAuditRow({
		transferId: "2:013_nu",
		rowKind: "terminal",
		savedAt: 13_000,
		eventCount: 4,
		lastEventAt: 13_010,
		info: { platformName: "pad", sourceInstanceId: 2, targetInstanceId: 1, status: "completed", startedAt: 13_000 },
	});

	const summaries = makeLogger({ extraRows: [trimmed] }).getTransferSummaries();

	assert.ok(byId(summaries).get("2:013_nu"),
		"no detail entry, and it must still appear — bounding the detail store depends on this");
});
