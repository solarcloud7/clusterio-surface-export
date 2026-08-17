"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const distNode = path.join(__dirname, "..", "dist", "node");
const { InstancePlugin } = require(path.join(distNode, "instance.js"));
const { ControllerPlugin } = require(path.join(distNode, "controller.js"));
const { createOperationRecord } = require(path.join(distNode, "lib", "operation-record.js"));
const { TransactionLogger } = require(path.join(distNode, "lib", "transaction-logger.js"));
const messages = require(path.join(distNode, "messages.js"));

const GATE_VERDICT = Object.freeze({
	success: false,
	itemCountMatch: false,
	fluidCountMatch: true,
	failedStage: "items",
	entityCount: 12,
	mismatchDetails: "Item mismatches: copper-plate: loss - expected 5000, got 0",
	expectedItemCounts: { "copper-plate": 5000, "iron-plate": 81 },
	actualItemCounts: { "iron-plate": 81 },
	expectedFluidCounts: {},
	actualFluidCounts: {},
	entityTypeBreakdown: { container: 1, inserter: 1, "transport-belt": 1 },
	itemTypesExpected: 2,
	itemTypesActual: 1,
	fluidTypesExpected: 0,
	fluidTypesActual: 0,
	totalExpectedItems: 5081,
	totalActualItems: 81,
	totalExpectedFluids: 0,
	totalActualFluids: 0,
	itemLossByType: { "copper-plate": { expected: 5000, actual: 0, loss: 5000 } },
	totalItemLoss: 5000,
});

const PASSING_VERDICT = Object.freeze({
	success: true,
	itemCountMatch: true,
	fluidCountMatch: true,
	entityCount: 12,
	expectedItemCounts: { "iron-plate": 81 },
	actualItemCounts: { "iron-plate": 81 },
	expectedFluidCounts: {},
	actualFluidCounts: {},
	itemTypesExpected: 1,
	itemTypesActual: 1,
	totalExpectedItems: 81,
	totalActualItems: 81,
	totalItemLoss: 0,
});

function makeSummaryHarness() {
	const logger = new TransactionLogger({
		platformTree: { resolveInstanceName: (id) => `instance-${id}` },
		transactionLogs: new Map(),
		platformStorage: new Map(),
	});
	return logger;
}

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

test("a failed discard is forwarded, so the operator learns a leftover platform exists", async () => {
	const { plugin, sent } = makeInstanceHarness();

	await plugin.handleImportCompleteValidation({
		platform_name: "uploaded platform",
		operation_id: "import:upload-1",
		success: false,
		failed_stage: "items",
		error: "Item mismatches: copper-plate: loss - expected 5000, got 0",
		cleanup_failed: true,
		cleanup_error: "GameUtils.delete_platform failed: returned false",
	});

	assert.equal(sent[0].success, false);
	assert.equal(sent[0].cleanupFailed, true);
	assert.match(sent[0].error, /leftover platform remains/);
	assert.ok(sent[0].error.includes("GameUtils.delete_platform failed: returned false"),
		"the discard failure's own reason must survive, not just the flag");
});

test("a deliberately preserved destination is stated, and is not a failed discard", async () => {
	const { plugin, sent } = makeInstanceHarness();

	await plugin.handleImportCompleteValidation({
		platform_name: "uploaded platform",
		operation_id: "import:upload-1",
		success: false,
		failed_stage: "items",
		error: "Item mismatches",
		destination_preserved: true,
	});

	assert.equal(sent[0].cleanupFailed, false);
	assert.equal(sent[0].destinationPreserved, true);
	assert.match(sent[0].error, /PRESERVED/);
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

test("a failed discard promotes the row past plain failed, so retries and metrics see it", async () => {
	const { plugin, operation } = makeControllerHarness();

	await plugin.handleImportOperationCompleteEvent(new messages.ImportOperationCompleteEvent({
		operationId: operation.transferId,
		platformName: "uploaded platform",
		instanceId: 2,
		success: false,
		error: "Import failed at items: …; destination discard FAILED — a leftover platform remains",
		failedStage: "items",
		cleanupFailed: true,
	}));

	assert.equal(operation.status, "cleanup_failed",
		"lib/metrics.ts maps cleanup_failed to its own result label, and the retry guards read the status");
	assert.equal(operation.failedStage, "items");
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

test("the destination's real verdict rides the event, value for value", async () => {
	const { plugin, sent } = makeInstanceHarness();

	await plugin.handleImportCompleteValidation({
		platform_name: "uploaded platform",
		operation_id: "import:upload-1",
		success: false,
		failed_stage: "items",
		error: GATE_VERDICT.mismatchDetails,
		validation: GATE_VERDICT,
	});

	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0].validation, GATE_VERDICT,
		"the round-trip harness proves the field AGREES with the schema; only a value pin proves the "
		+ "expected/actual counts the drawer tabulates are the destination's own numbers");
	assert.equal(sent[0].validation.expectedItemCounts["copper-plate"], 5000);
	assert.equal(sent[0].validation.actualItemCounts["copper-plate"], undefined);
});

test("a verdict survives the wire encoding, not just the constructor", () => {
	const event = new messages.ImportOperationCompleteEvent({
		operationId: "import:upload-1",
		platformName: "uploaded platform",
		instanceId: 2,
		success: false,
		validation: GATE_VERDICT,
	});

	const overWire = messages.ImportOperationCompleteEvent.fromJSON(JSON.parse(JSON.stringify(event.toJSON())));

	assert.deepEqual(overWire.validation, GATE_VERDICT,
		"instance and controller are separate processes — the verdict has to survive JSON, not just a "
		+ "constructor call in one heap");
	assert.ok(!messages.ImportOperationCompleteEvent.jsonSchema.required.includes("validation"),
		"an old instance sends no validation key; making it required would reject every event it emits");
});

test("no verdict on the wire is no verdict on the event", async () => {
	const { plugin, sent } = makeInstanceHarness();

	await plugin.handleImportCompleteValidation({
		platform_name: "uploaded platform",
		operation_id: "import:upload-1",
		entity_count: 12,
	});

	assert.equal(sent[0].validation, null,
		"a plain upload runs no exact gate — import-completion.lua attaches validation only under "
		+ "job.transfer_id, and a synthesized stand-in would render comparison tables that claim the "
		+ "destination was checked");
});

test("a verdict that is not an object is refused rather than forwarded", async () => {
	const { plugin, sent } = makeInstanceHarness();

	await plugin.handleImportCompleteValidation({
		platform_name: "uploaded platform",
		operation_id: "import:upload-1",
		success: false,
		error: "Import failed",
		validation: [],
	});

	assert.equal(sent[0].validation, null,
		"an empty Lua table serialises to [], not {} — and an array does not satisfy the field's "
		+ "type: [object, null], so the controller's ajv check would reject the WHOLE completion "
		+ "event, not merely mis-render a table: the row would hang at awaiting_completion");
});

test("a verdict that is a string is refused rather than forwarded", async () => {
	const { plugin, sent } = makeInstanceHarness();

	await plugin.handleImportCompleteValidation({
		platform_name: "uploaded platform",
		operation_id: "import:upload-1",
		success: false,
		failed_stage: "items",
		error: "Import failed",
		validation: "items",
	});

	assert.equal(sent[0].validation, null,
		"a bare string passes a truthiness check but fails the field's type: [object, null] at the "
		+ "controller, dropping the whole completion event — the typeof guard, not the truthiness, "
		+ "is what prevents that");
});

test("the real verdict lands on the operation record the drawer reads", async () => {
	const { plugin, operation } = makeControllerHarness();

	await plugin.handleImportOperationCompleteEvent(new messages.ImportOperationCompleteEvent({
		operationId: operation.transferId,
		platformName: "uploaded platform",
		instanceId: 2,
		success: false,
		error: `Import failed at items: ${GATE_VERDICT.mismatchDetails}`,
		failedStage: "items",
		validation: GATE_VERDICT,
	}));

	assert.deepEqual(operation.validationResult, GATE_VERDICT);

	const summary = makeSummaryHarness().buildDetailedTransferSummary(operation.transferId, operation);
	assert.deepEqual(summary.validation, GATE_VERDICT,
		"web/utils.ts buildDetailedLogSummary reads summary.validation, and TransactionLogsTab renders "
		+ "'Failure stage:' and the comparison tables from it");
	assert.equal(summary.validation.failedStage, "items");
	assert.deepEqual(summary.sourceVerification.itemCounts, GATE_VERDICT.expectedItemCounts,
		"the expected-counts column falls back to sourceVerification, which is derived from the verdict");
});

test("a PASSING verdict reaches the record too, and still completes the operation", async () => {
	const { plugin, operation } = makeControllerHarness();

	await plugin.handleImportOperationCompleteEvent(new messages.ImportOperationCompleteEvent({
		operationId: operation.transferId,
		platformName: "uploaded platform",
		instanceId: 2,
		success: true,
		validation: PASSING_VERDICT,
	}));

	assert.equal(operation.status, "completed");
	assert.deepEqual(operation.validationResult, PASSING_VERDICT,
		"import-completion.lua attaches the verdict under job.transfer_id regardless of success, so a "
		+ "transfer-shaped upload that PASSES its gate carries one too — consuming it only on the "
		+ "failure path would leave the drawer empty for every successful gated upload");

	const summary = makeSummaryHarness().buildDetailedTransferSummary(operation.transferId, operation);
	assert.equal(summary.validation.itemCountMatch, true);
});

test("an operation with no verdict is given none", async () => {
	const { plugin, operation } = makeControllerHarness();

	await plugin.handleImportOperationCompleteEvent(new messages.ImportOperationCompleteEvent({
		operationId: operation.transferId,
		platformName: "uploaded platform",
		instanceId: 2,
		success: true,
	}));

	assert.ok(!operation.validationResult,
		"a plain upload has no gate; an empty verdict object would render empty comparison tables that "
		+ "read as 'checked and found nothing'");

	const summary = makeSummaryHarness().buildDetailedTransferSummary(operation.transferId, operation);
	assert.equal(summary.validation, null,
		"TransactionLogsTab gates on Boolean(validation) to show 'No validation data available yet'");
	assert.equal(summary.sourceVerification, null);
});
