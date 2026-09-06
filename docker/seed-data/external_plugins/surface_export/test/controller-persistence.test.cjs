"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { loadStoredExports, persistStoredExports } = require("../dist/node/lib/export-storage");
const { loadControllerAudit, recordControllerAuditRow } = require("../dist/node/lib/controller-audit");
const { buildAuditRow } = require("../dist/node/lib/audit-ledger");

async function fixture(t) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "controller-persistence-"));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const messages = [];
	const logger = Object.fromEntries(["info", "warn", "error", "verbose"].map(level =>
		[level, message => messages.push({ level, message })]));
	return { directory, messages, logger };
}

function auditState(directory, logger, details = []) {
	return {
		auditLedgerPath: path.join(directory, "audit.jsonl"), logger,
		auditIndex: new Map(), auditRevisions: new Map(), persistedTransactionLogs: details,
	};
}

function row(id, kind, status) {
	return buildAuditRow({ transferId: id, rowKind: kind, savedAt: 100, eventCount: 1,
		lastEventAt: 100, info: { status, platformName: "fixture" } });
}

test("stored exports migrate legacy identity and survive a real disk round trip", async t => {
	const { directory, logger } = await fixture(t);
	const storagePath = path.join(directory, "exports.json");
	const payload = { platform: { name: "Orbité" } };
	await fs.writeFile(storagePath, JSON.stringify([
		{ exportId: "job-7", instanceId: 2, exportData: payload },
		{ exportId: "orphan", exportData: {} },
	]));
	const state = { storagePath, logger, platformStorage: new Map(), storageLoadError: null,
		consecutiveStorageWriteFailures: 0 };
	await loadStoredExports(state);
	assert.equal(state.platformStorage.get("2:job-7").sourceExportId, "job-7");
	assert.equal(state.platformStorage.get("2:job-7").size, Buffer.byteLength(JSON.stringify(payload), "utf8"));
	assert.ok(state.platformStorage.has("orphan"));
	await persistStoredExports(state);
	const fresh = { ...state, platformStorage: new Map() };
	await loadStoredExports(fresh);
	assert.deepEqual(fresh.platformStorage, state.platformStorage);
});

test("audit migration preserves detail records and survives a fresh load", async t => {
	const { directory, logger } = await fixture(t);
	const details = [
		{ transferId: "new", savedAt: 20, events: [{ timestampMs: 19 }], transferInfo: { status: "completed" } },
		{ transferId: "old", savedAt: 10, events: [], transferInfo: { status: "failed" } },
	];
	const original = structuredClone(details);
	const state = auditState(directory, logger, details);
	await loadControllerAudit(state);
	assert.deepEqual(details, original);
	assert.deepEqual([...state.auditIndex.keys()], ["old", "new"]);
	assert.equal(state.auditIndex.get("new").lastEventAt, 19);
	const saved = await fs.readFile(state.auditLedgerPath, "utf8");
	const fresh = auditState(directory, logger);
	await loadControllerAudit(fresh);
	assert.deepEqual(fresh.auditIndex, state.auditIndex);
	assert.deepEqual(fresh.auditRevisions, new Map([["old", 1], ["new", 1]]));
	assert.equal(await fs.readFile(state.auditLedgerPath, "utf8"), saved);
});

test("audit loading keeps valid rows around a damaged line without rewriting it", async t => {
	const { directory, logger, messages } = await fixture(t);
	const state = auditState(directory, logger);
	const bytes = `${JSON.stringify(row("one", "terminal", "completed"))}\n{broken\n${JSON.stringify(row("two", "terminal", "failed"))}\n`;
	await fs.writeFile(state.auditLedgerPath, bytes);
	await loadControllerAudit(state);
	assert.deepEqual([...state.auditIndex.keys()], ["one", "two"]);
	assert.ok(messages.some(entry => entry.level === "warn" && entry.message.includes("unreadable line 2")));
	assert.equal(await fs.readFile(state.auditLedgerPath, "utf8"), bytes);
});

test("a late start cannot downgrade a terminal audit in memory or after restart", async t => {
	const { directory, logger } = await fixture(t);
	const state = auditState(directory, logger);
	const terminal = row("one", "terminal", "completed");
	await recordControllerAuditRow(state, terminal);
	await recordControllerAuditRow(state, row("one", "start", "transporting"));
	assert.strictEqual(state.auditIndex.get("one"), terminal);
	assert.equal(state.auditRevisions.get("one"), 1);
	const fresh = auditState(directory, logger);
	await loadControllerAudit(fresh);
	assert.deepEqual(fresh.auditIndex.get("one"), terminal);
	assert.equal(fresh.auditRevisions.get("one"), 1);
});

test("an audit write failure leaves its in-memory index and revisions unchanged", async t => {
	const { directory, logger, messages } = await fixture(t);
	const state = auditState(directory, logger);
	state.auditLedgerPath = directory;
	const terminal = row("one", "terminal", "completed");
	state.auditIndex.set("one", terminal);
	state.auditRevisions.set("one", 1);
	await recordControllerAuditRow(state, row("two", "terminal", "failed"));
	assert.deepEqual([...state.auditIndex], [["one", terminal]]);
	assert.deepEqual([...state.auditRevisions], [["one", 1]]);
	assert.ok(messages.some(entry => entry.level === "error" && entry.message.includes("failed to record")));
});
