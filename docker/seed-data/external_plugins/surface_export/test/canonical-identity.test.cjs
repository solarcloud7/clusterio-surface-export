"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
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
const helpers = require(path.join(distNode, "helpers.js"));
const { ControllerPlugin } = require(path.join(distNode, "controller.js"));
const { TransferOrchestrator } = require(path.join(distNode, "lib", "transfer-orchestrator.js"));
const messages = require(path.join(distNode, "messages.js"));

test("canonical transfer id helpers qualify by numeric source instance and parse by first colon", () => {
	assert.equal(helpers.makeCanonicalTransferId(1, "001_test"), "1:001_test");
	assert.deepEqual(helpers.parseCanonicalTransferId("12:001_alpha:debug"), {
		sourceInstanceId: 12,
		sourceJobId: "001_alpha:debug",
	});
	assert.equal(helpers.parseCanonicalTransferId("uploaded_123"), null);
	assert.equal(helpers.parseCanonicalTransferId("abc:001_test"), null);
});

function makeControllerHarness() {
	const calls = { persisted: 0, broadcasts: 0, warns: [] };
	const plugin = Object.create(ControllerPlugin.prototype);
	plugin.platformStorage = new Map();
	plugin.logger = { info() {}, verbose() {}, error(msg) { throw new Error(msg); }, warn(msg) { calls.warns.push(msg); } };
	plugin.cfg = () => 100;
	plugin.persistStorage = async () => { calls.persisted++; };
	plugin.subscriptions = { queueTreeBroadcast: () => { calls.broadcasts++; } };
	return { plugin, calls };
}

test("controller stores source exports by canonical sourceInstanceId:sourceExportId key", async () => {
	const { plugin } = makeControllerHarness();

	await plugin.handlePlatformExport({
		exportId: "001_test",
		platformName: "test",
		platformIndex: 3,
		instanceId: 1,
		exportData: { platform: { index: 3, force: "player" } },
		timestamp: 1000,
		exportMetrics: null,
	});
	await plugin.handlePlatformExport({
		exportId: "001_test",
		platformName: "test",
		platformIndex: 4,
		instanceId: 2,
		exportData: { platform: { index: 4, force: "player" } },
		timestamp: 1001,
		exportMetrics: null,
	});

	assert.deepEqual([...plugin.platformStorage.keys()].sort(), ["1:001_test", "2:001_test"]);
	assert.equal(plugin.platformStorage.get("1:001_test").sourceExportId, "001_test");
	assert.equal(plugin.platformStorage.get("2:001_test").sourceExportId, "001_test");
	assert.equal(plugin.platformStorage.get("2:001_test").exportId, "2:001_test");
});

test("controller loadStorage migrates legacy raw source export ids without dropping unmigratable entries", async () => {
	const { plugin, calls } = makeControllerHarness();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-export-storage-"));
	plugin.storagePath = path.join(dir, "exports.json");
	fs.writeFileSync(plugin.storagePath, JSON.stringify([
		{ exportId: "001_test", platformName: "legacy", platformIndex: 1, instanceId: 7, exportData: {}, timestamp: 1, size: 2 },
		{ exportId: "8:002_done", sourceExportId: "002_done", platformName: "done", platformIndex: 2, instanceId: 8, exportData: {}, timestamp: 2, size: 2 },
		{ exportId: "orphan", platformName: "orphan", platformIndex: null, exportData: {}, timestamp: 3, size: 2 },
	]));

	await plugin.loadStorage();

	assert.ok(plugin.platformStorage.has("7:001_test"));
	assert.equal(plugin.platformStorage.get("7:001_test").sourceExportId, "001_test");
	assert.ok(plugin.platformStorage.has("8:002_done"));
	assert.ok(plugin.platformStorage.has("orphan"));
	assert.match(calls.warns.join("\n"), /Cannot canonicalize stored export/);
});

function makeTransferHarness() {
	const calls = { imports: [], sourceDeletes: [], storageDeletes: [] };
	const activeTransfers = new Map();
	const stored = {
		exportId: "1:001_test",
		sourceExportId: "001_test",
		exportData: { platform: { index: 3, force: "player" } },
		exportMetrics: null,
		platformName: "test-platform",
		platformIndex: 3,
		instanceId: 1,
		size: 123,
	};
	const plugin = {
		logger: { error() {}, warn() {}, info() {}, verbose() {} },
		persistPendingTransfer: () => {},
		removePendingTransfer: () => {},
		persistStorage: async () => {},
		platformStorage: {
			get: (id) => id === "1:001_test" ? stored : null,
			delete: (id) => { calls.storageDeletes.push(id); },
		},
		platformTree: {
			resolveInstanceName: (id) => "instance-" + id,
			resolveTargetInstance: (id) => ({ id }),
		},
		activeTransfers,
		txLogger: {
			logTransactionEvent() {},
			startPhase() {},
			endPhase: () => 0,
			persistTransactionLog: async () => {},
			buildPhaseSummary: () => ({}),
		},
		subscriptions: { emitTransferUpdate() {}, queueTreeBroadcast() {} },
		controller: {
			sendTo: async (_dst, msg) => {
				if (msg && msg.constructor && msg.constructor.name === "ImportPlatformRequest") {
					calls.imports.push(msg.toJSON());
					return { success: true };
				}
				if (msg && msg.constructor && msg.constructor.name === "DeleteSourcePlatformRequest") {
					calls.sourceDeletes.push(msg.toJSON());
					return { success: true };
				}
				return { success: true };
			},
		},
	};
	return { orch: new TransferOrchestrator(plugin, messages), activeTransfers, calls };
}

test("TransferPlatformRequest serializes canonical export id and raw source id", () => {
	const request = new messages.TransferPlatformRequest({
		exportId: "1:001_test",
		targetInstanceId: 2,
		sourceInstanceId: 1,
		sourceExportId: "001_test",
	});
	assert.deepEqual(request.toJSON(), {
		exportId: "1:001_test",
		targetInstanceId: 2,
		sourceInstanceId: 1,
		sourceExportId: "001_test",
	});
});

test("handleTransferPlatformRequest re-derives canonical id from source parts when request exportId is raw", async () => {
	const { orch, activeTransfers, calls } = makeTransferHarness();
	const result = await orch.handleTransferPlatformRequest({
		exportId: "001_test",
		targetInstanceId: 2,
		sourceInstanceId: 1,
		sourceExportId: "001_test",
	});
	assert.equal(result.success, true);
	assert.equal(result.transferId, "1:001_test");
	assert.equal(calls.imports[0].exportId, "1:001_test");
	assert.equal(calls.imports[0].exportData._transferId, "1:001_test");
	for (const transfer of activeTransfers.values()) {
		if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);
	}
});

test("transferPlatform is idempotent for canonical replay and does not resend import", async () => {
	const { orch, activeTransfers, calls } = makeTransferHarness();
	const first = await orch.transferPlatform("1:001_test", 2);
	const second = await orch.transferPlatform("1:001_test", 2);
	for (const transfer of activeTransfers.values()) {
		if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);
	}
	assert.equal(first.success, true);
	assert.equal(second.success, true);
	assert.equal(second.transferId, "1:001_test");
	assert.equal(calls.imports.length, 1, "replayed canonical transfer must not resend import");
	assert.equal(activeTransfers.size, 1, "replayed canonical transfer must not overwrite active transfer state");
});

test("transfer uses canonical id everywhere except raw source delete correlation", async () => {
	const { orch, activeTransfers, calls } = makeTransferHarness();
	const result = await orch.transferPlatform("1:001_test", 2);
	for (const transfer of activeTransfers.values()) {
		if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);
	}
	assert.equal(result.transferId, "1:001_test");
	const transfer = activeTransfers.get("1:001_test");
	assert.ok(transfer, "active transfer must be keyed by canonical id");
	assert.equal(transfer.sourceExportId, "001_test");
	assert.equal(calls.imports[0].exportId, "1:001_test");
	assert.equal(calls.imports[0].exportData._transferId, "1:001_test");

	await orch.handleTransferValidation({
		transferId: "1:001_test",
		success: true,
		platformName: "test-platform",
		sourceInstanceId: 1,
		validation: { itemCountMatch: true, fluidCountMatch: true },
	});
	assert.equal(calls.sourceDeletes[0].exportId, "001_test", "source delete must use raw source job id");
	assert.deepEqual(calls.storageDeletes, ["1:001_test"]);
});
