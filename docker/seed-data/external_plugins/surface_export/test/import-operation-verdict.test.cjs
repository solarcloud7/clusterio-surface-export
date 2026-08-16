"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const distNode = path.join(__dirname, "..", "dist", "node");
const { InstancePlugin } = require(path.join(distNode, "instance.js"));
const { ControllerPlugin } = require(path.join(distNode, "controller.js"));
const { createOperationRecord } = require(path.join(distNode, "lib", "operation-record.js"));
const messages = require(path.join(distNode, "messages.js"));

function makeInstanceHarness() {
	const sent = [];
	const errors = [];
	const plugin = Object.create(InstancePlugin.prototype);
	plugin.instance = {
		id: 22,
		sendTo: async (_dst, message) => {
			sent.push(message.toJSON ? message.toJSON() : message);
			return { success: true };
		},
	};
	plugin.logger = { info() {}, warn() {}, error: (message) => errors.push(message), verbose() {} };
	plugin.lua = new Proxy({}, {
		get(_target, prop) {
			throw new Error(`Lua helper ${String(prop)} must not run for an import completion`);
		},
	});
	plugin.handlePlatformStateChanged = async () => {};
	return { plugin, sent, errors };
}

function makeControllerHarness() {
	const logged = [];
	const operation = createOperationRecord("import", {
		operationId: "import:upload-1",
		platformName: "uploaded platform",
		sourceInstanceId: -1,
		sourceInstanceName: "Uploaded JSON",
		targetInstanceId: 2,
	});
	const plugin = Object.create(ControllerPlugin.prototype);
	plugin.activeTransfers = new Map([[operation.transferId, operation]]);
	plugin.logger = { info() {}, warn() {}, error() {}, verbose() {} };
	plugin.txLogger = {
		logTransactionEvent: (transferId, eventType, message, data) =>
			logged.push({ transferId, eventType, message, data }),
		persistTransactionLog: async () => {},
	};
	plugin.subscriptions = { emitTransferUpdate() {}, queueTreeBroadcast() {} };
	plugin.platformTree = { resolveInstanceName: (id) => `instance-${id}` };
	plugin.orchestrator = { pruneOldTransfers() {} };
	return { plugin, operation, logged };
}

test("an ABSENT success key is a successful upload, not a failure", async () => {
	const { plugin, sent } = makeInstanceHarness();

	await plugin.handleImportCompleteValidation({
		platform_name: "uploaded platform",
		operation_id: "import:upload-1",
		entity_count: 12,
		duration_ticks: 300,
	});

	assert.equal(sent.length, 1, "one ImportOperationCompleteEvent must be emitted");
	assert.equal(sent[0].success, true,
		"import-completion.lua emits `validation_result and validation_result.success == true`, and "
		+ "validation_result is nil for a successful non-transfer upload — the key is absent, not false");
	assert.equal(sent[0].error, null);
	assert.equal(sent[0].failedStage, null);
});

test("an explicit success=false is forwarded with the stage and reason the destination reported", async () => {
	const { plugin, sent, errors } = makeInstanceHarness();
	const reported = "belt side-restore reported 1 structural anomalies on a non-transfer import";

	await plugin.handleImportCompleteValidation({
		platform_name: "uploaded platform",
		operation_id: "import:upload-1",
		success: false,
		failed_stage: "belts",
		error: reported,
	});

	assert.equal(sent.length, 1);
	assert.equal(sent[0].success, false);
	assert.equal(sent[0].failedStage, "belts");
	assert.match(sent[0].error, /belts/);
	assert.ok(sent[0].error.includes(reported), "the destination's own reason must survive to the controller");
	assert.equal(errors.length, 1, "a refused import must be visible in the instance log too");
});

test("success=false with no reason still fails, with a stated default", async () => {
	const { plugin, sent } = makeInstanceHarness();

	await plugin.handleImportCompleteValidation({
		platform_name: "uploaded platform",
		operation_id: "import:upload-1",
		success: false,
	});

	assert.equal(sent[0].success, false);
	assert.equal(sent[0].failedStage, null);
	assert.ok(typeof sent[0].error === "string" && sent[0].error.length > 0,
		"a failure with no reason must still carry an error string");
});

test("an explicit success=true stays successful", async () => {
	const { plugin, sent } = makeInstanceHarness();

	await plugin.handleImportCompleteValidation({
		platform_name: "uploaded platform",
		operation_id: "import:upload-1",
		success: true,
	});

	assert.equal(sent[0].success, true);
	assert.equal(sent[0].error, null);
});

test("the controller marks the operation failed and keeps the stage the metric labels", async () => {
	const { plugin, operation, logged } = makeControllerHarness();

	await plugin.handleImportOperationCompleteEvent(new messages.ImportOperationCompleteEvent({
		operationId: operation.transferId,
		platformName: "uploaded platform",
		instanceId: 2,
		success: false,
		error: "Import failed at belts: belt side-restore reported 1 structural anomalies",
		failedStage: "belts",
	}));

	assert.equal(operation.status, "failed");
	assert.match(operation.error, /belts/);
	assert.equal(operation.failedStage, "belts");
	assert.ok(logged.some(entry => entry.eventType === "import_failed"));
});

test("an unrecognised stage never reaches the operation record", async () => {
	const { plugin, operation } = makeControllerHarness();

	await plugin.handleImportOperationCompleteEvent(new messages.ImportOperationCompleteEvent({
		operationId: operation.transferId,
		platformName: "uploaded platform",
		instanceId: 2,
		success: false,
		error: "Import failed at hub: something else",
		failedStage: "hub",
	}));

	assert.equal(operation.status, "failed");
	assert.ok(!operation.failedStage,
		"surface_export_operations_total's failure_stage label is a closed set — an unknown stage stays off "
		+ "the record instead of becoming a new label value");
});

test("a successful completion event still completes the operation", async () => {
	const { plugin, operation, logged } = makeControllerHarness();

	await plugin.handleImportOperationCompleteEvent(new messages.ImportOperationCompleteEvent({
		operationId: operation.transferId,
		platformName: "uploaded platform",
		instanceId: 2,
		success: true,
	}));

	assert.equal(operation.status, "completed");
	assert.equal(operation.error, null);
	assert.ok(logged.some(entry => entry.eventType === "import_completed"));
});
