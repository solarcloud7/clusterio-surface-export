"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const originalLoad = Module._load;
let failWrites = false;
let writes = 0;
Module._load = function(request, parent, isMain) {
	if (request === "@clusterio/lib") {
		return { safeOutputFile: async (file, data) => {
			writes += 1;
			if (failWrites) throw new Error("disk full");
			await fs.writeFile(file, data);
		} };
	}
	return originalLoad.call(this, request, parent, isMain);
};
const { LineageRegistry, LINEAGE_REGISTRY_FILENAME, isLineage, lineageCommitPlan, transferCommitDecision } = require("../dist/node/lib/lineage-registry");
Module._load = originalLoad;

const L = "lineage:boot-a:15";
const commit = (overrides = {}) => ({ lineage: L, transferId: "1:job", sourceInstanceId: 1, targetInstanceId: 2,
	fromGeneration: 0, toGeneration: 1, platformName: "ship", forceName: "player", ...overrides });
const entry = (overrides = {}) => ({ instanceId: 1, generation: 0, platformName: "ship", forceName: "player",
	lastExportId: null, updatedAt: 1, source: "claim", ...overrides });

async function tempFile(t) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lineage-registry-"));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	return path.join(dir, LINEAGE_REGISTRY_FILENAME);
}

test("a lineage is only the prefixed travelling identity, never a per-copy uid", () => {
	assert.equal(isLineage(L), true);
	for (const value of ["boot-a:15", "lineage:boot-a:0", "lineage::15", "lineage:a:b:15", "lineage:boot a:15", null, 15]) {
		assert.equal(isLineage(value), false, String(value));
	}
});

test("the transfer compare-and-set writes only from the recorded holder and generation", () => {
	assert.equal(transferCommitDecision(undefined, commit()), "write", "an unclaimed generation-zero lineage may transfer");
	assert.match(transferCommitDecision(undefined, commit({ fromGeneration: 2, toGeneration: 3 })), /no registry entry/);
	assert.equal(transferCommitDecision(entry(), commit()), "write");
	assert.match(transferCommitDecision(entry({ instanceId: 9 }), commit()), /instance 9/, "another holder was overwritten");
	assert.match(transferCommitDecision(entry({ generation: 1 }), commit()), /generation 1/, "a stale generation was overwritten");
	assert.equal(transferCommitDecision(entry({ instanceId: 2, generation: 1, lastExportId: "1:job", source: "transfer" }), commit()), "noop");
	assert.notEqual(transferCommitDecision(entry({ instanceId: 2, generation: 1, lastExportId: "1:other", source: "transfer" }), commit()), "noop",
		"another transfer's commit was treated as this one");
	assert.match(transferCommitDecision(undefined, commit({ toGeneration: 2 })), /one generation/);
	assert.match(transferCommitDecision(undefined, commit({ lineage: "1:15" })), /valid lineage/);
});

test("the hold must carry the intent lineage at the next generation", () => {
	assert.deepEqual(lineageCommitPlan({}, {}), { kind: "legacy" });
	assert.deepEqual(lineageCommitPlan({ lineage: null }, { success: true }), { kind: "legacy" });
	assert.equal(lineageCommitPlan({ lineage: L, lineageGeneration: 0 }, {}).kind, "refused", "one side without a lineage committed");
	assert.equal(lineageCommitPlan({}, { lineage: L, generation: 1 }).kind, "refused", "one side without a lineage committed");
	assert.equal(lineageCommitPlan({ lineage: L, lineageGeneration: 0 }, { lineage: "lineage:other:15", generation: 1 }).kind, "refused");
	assert.equal(lineageCommitPlan({ lineage: L, lineageGeneration: 0 }, { lineage: L, generation: 2 }).kind, "refused");
	assert.equal(lineageCommitPlan({ lineage: "1:15", lineageGeneration: 0 }, { lineage: "1:15", generation: 1 }).kind, "refused");
	assert.deepEqual(lineageCommitPlan({ lineage: L, lineageGeneration: 4 }, { lineage: L, generation: 5 }),
		{ kind: "lineage", lineage: L, fromGeneration: 4, toGeneration: 5 });
});

test("an absent registry is empty and every commit persists before it takes effect", async t => {
	const file = await tempFile(t);
	const registry = new LineageRegistry(() => 42);
	await registry.load(file);
	assert.equal(registry.loadError, null);
	assert.equal(registry.get(L), undefined);
	assert.equal(await registry.commitTransfer(commit()), "write");
	assert.equal(await registry.commitTransfer(commit()), "noop", "a retried commit is idempotent");
	await assert.rejects(registry.commitTransfer(commit({ transferId: "1:other" })), /refused/);
	const reloaded = new LineageRegistry();
	await reloaded.load(file);
	assert.deepEqual(reloaded.get(L), { instanceId: 2, generation: 1, platformName: "ship", forceName: "player",
		lastExportId: "1:job", updatedAt: 42, source: "transfer" });
});

test("a failed write leaves the registry unchanged and the caller informed", async t => {
	const file = await tempFile(t);
	const registry = new LineageRegistry();
	await registry.load(file);
	failWrites = true;
	try { await assert.rejects(registry.commitTransfer(commit()), /disk full/); }
	finally { failWrites = false; }
	assert.equal(registry.get(L), undefined, "an unsaved commit took effect");
	assert.equal(registry.precheckTransfer(commit()), null);
	assert.equal(await registry.commitTransfer(commit()), "write", "the queue stayed usable after a failed write");
});

test("a missing registry is flagged so the controller can refuse it when history shows it was written", async t => {
	const file = await tempFile(t);
	const registry = new LineageRegistry();
	await registry.load(file);
	assert.deepEqual([registry.fileMissing, registry.loadError], [true, null]);
	registry.markUnreadable("the file is missing");
	assert.match(registry.loadError, /unreadable \(the file is missing\)/);
	await assert.rejects(registry.update(draft => draft.set(L, entry())), /unreadable/);
	assert.match(registry.precheckTransfer(commit()), /unreadable/);
	await fs.writeFile(file, JSON.stringify({ version: 1, entries: [] }));
	await registry.load(file);
	assert.deepEqual([registry.fileMissing, registry.loadError], [false, null], "an empty registry file was not accepted as the deliberate repair");
});

test("an unreadable registry refuses every lineage operation", async t => {
	const file = await tempFile(t);
	for (const content of ["not json", JSON.stringify({ version: 2, entries: [] }),
		JSON.stringify({ version: 1, entries: [["1:15", entry()]] }),
		JSON.stringify({ version: 1, entries: [[L, entry()], [L, entry()]] }),
		JSON.stringify({ version: 1, entries: [[L, entry({ generation: -1 })]] })]) {
		await fs.writeFile(file, content);
		const registry = new LineageRegistry();
		await registry.load(file);
		assert.match(registry.loadError, /unreadable/, content);
		assert.match(registry.precheckTransfer(commit()), /unreadable/);
		await assert.rejects(registry.commitTransfer(commit()), /unreadable/);
		await assert.rejects(registry.update(() => undefined), /unreadable/);
		assert.equal(await fs.readFile(file, "utf8"), content, "an unreadable registry was overwritten");
	}
});

test("generations only increase and entries are never removed", async t => {
	const registry = new LineageRegistry();
	await registry.load(await tempFile(t));
	await registry.update(draft => { draft.set(L, entry({ generation: 2 })); });
	await assert.rejects(registry.update(draft => { draft.set(L, entry({ generation: 2, platformName: "renamed" })); }), /must increase/);
	await assert.rejects(registry.update(draft => { draft.set(L, entry({ generation: 1 })); }), /must increase/);
	await assert.rejects(registry.update(draft => { draft.delete(L); }), /cannot be removed/);
	await assert.rejects(registry.update(draft => { draft.set("1:15", entry()); }), /Invalid lineage/);
	assert.equal(registry.get(L).generation, 2);
	const before = writes;
	await registry.update(() => undefined);
	assert.equal(writes, before, "an unchanged registry was rewritten");
});

test("registry updates are serialized so two claims of one lineage cannot both succeed", async t => {
	const registry = new LineageRegistry();
	await registry.load(await tempFile(t));
	const claim = instanceId => registry.update(draft => {
		if (draft.has(L)) return false;
		draft.set(L, entry({ instanceId }));
		return true;
	});
	const results = await Promise.all([claim(1), claim(2)]);
	assert.deepEqual(results, [true, false]);
	assert.equal(registry.get(L).instanceId, 1);
});
