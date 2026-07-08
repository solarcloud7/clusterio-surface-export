"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const originalLoad = Module._load;
const metricDefinitions = [];
class NoopMetric {
	constructor(name, help, options) {
		metricDefinitions.push({ name, help, options });
	}
	labels(labels) {
		this.lastLabels = labels;
		return this;
	}
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
	if (request === "@clusterio/host") {
		return { BaseInstancePlugin: class {} };
	}
	return originalLoad.call(this, request, parent, isMain);
};

const distNode = path.join(__dirname, "..", "dist", "node");
const moduleRoot = path.join(__dirname, "..", "module");
const { InstancePlugin } = require(path.join(distNode, "instance.js"));
const { TransferOrchestrator } = require(path.join(distNode, "lib", "transfer-orchestrator.js"));
require(path.join(distNode, "lib", "metrics.js"));

function makeInstanceHarness() {
	const calls = { sent: [], luaAccesses: 0, platformStateChanged: [] };
	const plugin = Object.create(InstancePlugin.prototype);
	plugin.instance = {
		id: 22,
		sendTo: async (_dst, msg) => {
			calls.sent.push(msg.toJSON ? msg.toJSON() : msg);
			return { success: true };
		},
	};
	plugin.logger = { info() {}, warn() {}, error() {}, verbose() {} };
	plugin.lua = new Proxy({}, {
		get(_target, prop) {
			calls.luaAccesses++;
			throw new Error(`Lua helper ${String(prop)} must not run for transfer verdicts`);
		},
	});
	plugin.handlePlatformStateChanged = async (payload) => {
		calls.platformStateChanged.push(payload);
	};
	return { plugin, calls };
}

test("instance forwards Lua composite verdict payload without name-keyed refetch or re-derivation", async () => {
	const { plugin, calls } = makeInstanceHarness();
	const validation = {
		itemCountMatch: true,
		fluidCountMatch: false,
		failedStage: "fluids",
		mismatchDetails: "Fluid mismatches: water: fluid completely lost",
	};

	await plugin.handleImportCompleteValidation({
		platform_name: "Renamable Display Name",
		transfer_id: "1:001_composite",
		source_instance_id: 1,
		success: false,
		validation,
		metrics: { fluids_restored: 4, phase_spans: [{ name: "fluids", duration_ms: 10 }] },
	});

	assert.equal(calls.luaAccesses, 0, "transfer verdict must come from the event payload, not a Lua refetch");
	assert.equal(calls.sent.length, 1, "one TransferValidationEvent must be emitted");
	assert.equal(calls.sent[0].transferId, "1:001_composite");
	assert.equal(calls.sent[0].success, false, "payload success is the authoritative composite verdict");
	assert.deepEqual(calls.sent[0].validation, validation);
	assert.equal(calls.sent[0].metrics.fluids_restored, 4);
	assert.deepEqual(calls.sent[0].metrics.phase_spans, [{ name: "fluids", duration_ms: 10 }]);
});

test("instance fails closed on success-only transfer payload without validation", async () => {
	const { plugin, calls } = makeInstanceHarness();

	await plugin.handleImportCompleteValidation({
		platform_name: "Malformed Success Only",
		transfer_id: "1:001_success_only",
		source_instance_id: 1,
		success: true,
		metrics: { fluids_restored: 4 },
	});

	assert.equal(calls.luaAccesses, 0, "transfer verdict must not fall back to a Lua refetch");
	assert.equal(calls.sent.length, 1, "one fail-closed TransferValidationEvent must be emitted");
	assert.equal(calls.sent[0].success, false, "missing validation payload must fail closed even when data.success is true");
	assert.equal(calls.sent[0].validation.itemCountMatch, false);
	assert.equal(calls.sent[0].validation.fluidCountMatch, false);
	assert.match(calls.sent[0].validation.mismatchDetails, /Validation payload not retrieved/);
});

function makeTransferHarness() {
	const noop = () => {};
	const activeTransfers = new Map();
	const transfer = {
		transferId: "1:001_composite",
		operationType: "transfer",
		exportId: "1:001_composite",
		sourceExportId: "001_composite",
		artifactSizeBytes: 1,
		platformName: "test-platform",
		platformIndex: 3,
		forceName: "player",
		sourceInstanceId: 1,
		sourceInstanceName: "source",
		targetInstanceId: 2,
		targetInstanceName: "dest",
		startedAt: Date.now(),
		status: "awaiting_validation",
		validationTimeout: null,
	};
	activeTransfers.set(transfer.transferId, transfer);
	const plugin = {
		logger: { error() {}, warn() {}, info() {}, verbose() {} },
		activeTransfers,
		txLogger: {
			logTransactionEvent: noop,
			startPhase: noop,
			endPhase: () => 0,
			persistTransactionLog: async () => {},
			buildPhaseSummary: () => ({}),
		},
		subscriptions: { emitTransferUpdate: noop, queueTreeBroadcast: noop },
		removePendingTransfer: noop,
		controller: { sendTo: async () => ({ success: true }) },
	};
	const orch = new TransferOrchestrator(plugin, require(path.join(distNode, "messages.js")));
	orch.tryUnlockSource = async () => null;
	orch.broadcastTransferStatus = async () => {};
	orch.pruneOldTransfers = noop;
	return { orch, transfer };
}

test("orchestrator preserves failedStage from the composite verdict on failed transfers", async () => {
	const { orch, transfer } = makeTransferHarness();

	await orch.handleTransferValidation({
		transferId: transfer.transferId,
		success: false,
		platformName: transfer.platformName,
		sourceInstanceId: transfer.sourceInstanceId,
		validation: {
			itemCountMatch: true,
			fluidCountMatch: false,
			failedStage: "fluids",
			mismatchDetails: "Fluid gate failed",
		},
	});

	assert.equal(transfer.status, "failed");
	assert.equal(transfer.failedStage, "fluids");
	assert.equal(transfer.validationResult.failedStage, "fluids");
});

test("operation outcome metrics expose bounded failure_stage label", () => {
	const operationsMetric = metricDefinitions.find(def => def.name === "surface_export_operations_total");
	assert.ok(operationsMetric, "operations total metric should be registered");
	assert.deepEqual(operationsMetric.options.labels, ["operation", "result", "failure_stage"]);
});

test("Lua import completion gates post-activation fluids and discards the destination on fluid failure", () => {
	const importCompletion = fs.readFileSync(path.join(moduleRoot, "core", "import-completion.lua"), "utf8");
	assert.match(importCompletion, /TransferValidation\.validate_fluids_post_activation\s*\(\s*result\s*\)/,
		"post-activation fluid reconciliation must become a real validation gate");
	assert.match(importCompletion, /result\.success\s*=\s*result\.itemCountMatch\s+and\s+result\.fluidCountMatch/,
		"Lua must compose the single composite verdict before emitting it");
	const transferValidation = fs.readFileSync(path.join(moduleRoot, "validators", "transfer-validation.lua"), "utf8");
	assert.match(transferValidation, /result\.failedStage\s*=\s*["']fluids["']/,
		"fluid gate failure must label failedStage=fluids in the validation helper");
	assert.match(importCompletion, /GameUtils\.delete_platform\s*\(\s*job\.target_platform\s*\)/,
		"fluid-stage failure happens after activation, so the destination artifact must be deleted before rollback");
	assert.match(importCompletion, /event_payload\.success\s*=\s*validation_result\s+and\s+validation_result\.success\s*==\s*true/,
		"the Clusterio import-complete message must carry the Lua composite verdict");
	assert.match(importCompletion, /function\s+emit_debug_import_result\s*\([\s\S]*validation_success\s*=\s*validation_result\s+and\s+validation_result\.success\s*==\s*true/,
		"debug import-result must contain the final composite verdict through the shared emitter");
	assert.doesNotMatch(importCompletion, /store_validation_result\s*\(\s*job\.platform_name\s*,\s*result\s*\)/,
		"transfer validation storage must not be keyed by mutable platform name");
	const successPrintIndex = importCompletion.indexOf("[Validation] ✓ Validation passed");
	const fluidGateIndex = importCompletion.indexOf("TransferValidation.validate_fluids_post_activation");
	assert.ok(successPrintIndex > fluidGateIndex,
		"green validation-passed player message must only appear after the post-activation fluid gate");
});

test("fluid verdict is commensurate by fluid name, not exact low-temp temperature key", () => {
	const transferValidation = fs.readFileSync(path.join(moduleRoot, "validators", "transfer-validation.lua"), "utf8");
	assert.match(transferValidation, /function\s+aggregate_fluid_counts_by_name\s*\(/,
		"destructive fluid gate must aggregate by fluid name so temperature-key drift cannot look like total loss");
	assert.match(transferValidation, /expected_by_name[\s\S]*actual_by_name[\s\S]*all_names/,
		"fluid gate must compare expected and actual totals over the same fluid-name set");
	assert.doesNotMatch(transferValidation, /actual_volume\s*<\s*1/,
		"destructive fluid gate must not classify an exact low-temp key miss as complete fluid loss");
});

test("fluid-gate discard failure re-quarantines the destination instead of leaving a live duplicate", () => {
	const importCompletion = fs.readFileSync(path.join(moduleRoot, "core", "import-completion.lua"), "utf8");
	assert.match(importCompletion, /function\s+quarantine_destination_after_discard_failure\s*\(/,
		"delete failure after an activated fluid-gate reject needs a single quarantine helper");
	assert.match(importCompletion, /if\s+not\s+discarded\s+then[\s\S]*quarantine_destination_after_discard_failure\s*\(\s*job\s*,\s*result\s*\)/,
		"a failed destination discard must immediately re-quarantine the artifact");
	assert.match(importCompletion, /platform\.paused\s*=\s*true/,
		"quarantine must pause the surviving destination platform");
	assert.match(importCompletion, /set_surface_hidden\(\s*surface\s*,\s*true\s*\)/,
		"quarantine must hide the surviving destination surface");
	assert.match(importCompletion, /entity\.active\s*=\s*false/,
		"quarantine must deactivate activatable entities on the surviving destination");
	assert.match(importCompletion, /destinationDiscardEscalated/,
		"failed discard must be surfaced as an escalated result field");
});

test("import completion emits a post-item debug result before risky post-gate phases", () => {
	const importCompletion = fs.readFileSync(path.join(moduleRoot, "core", "import-completion.lua"), "utf8");
	assert.match(importCompletion, /function\s+emit_debug_import_result\s*\(/,
		"debug import-result emission should be centralized so pre/post verdict dumps cannot drift");
	const itemGateAt = importCompletion.indexOf("result.success = result.itemCountMatch and result.fluidCountMatch");
	const activationAt = importCompletion.indexOf("ActiveStateRestoration.restore(job.entities_to_create");
	const firstDebugAt = importCompletion.indexOf("emit_debug_import_result(job, validation_result, duration_seconds", itemGateAt);
	assert.ok(itemGateAt !== -1 && activationAt !== -1 && firstDebugAt !== -1 && firstDebugAt < activationAt,
		"a post-item-gate debug result must land before activation/fluid/loss can throw");
});

test("Lua verdict fields have single owners and no truthiness idiom traps", () => {
	const importCompletion = fs.readFileSync(path.join(moduleRoot, "core", "import-completion.lua"), "utf8");
	assert.doesNotMatch(importCompletion, /success\s+and\s+nil\s+or\s+["']items["']/,
		"Lua 'success and nil or items' always yields items on success; use an explicit nil-safe expression");
	const callerFluidStageWrites = [...importCompletion.matchAll(/result\.failedStage\s*=\s*["']fluids["']/g)];
	assert.equal(callerFluidStageWrites.length, 0,
		"validate_fluids_post_activation should be the single writer for failedStage=fluids");
});

test("TransferValidation exposes a reusable post-activation fluid gate keyed by transfer id", () => {
	const transferValidation = fs.readFileSync(path.join(moduleRoot, "validators", "transfer-validation.lua"), "utf8");
	assert.match(transferValidation, /function\s+TransferValidation\.validate_fluids_post_activation\s*\(/,
		"fluid gate should reuse the existing reconciliation logic through a named helper");
	assert.match(transferValidation, /function\s+TransferValidation\.store_validation_result\s*\(\s*result_id\s*,\s*validation_result\s*\)/,
		"validation result store should use transfer/job id, not platform name");
	assert.match(transferValidation, /function\s+TransferValidation\.get_validation_result\s*\(\s*result_id\s*\)/,
		"debug remote should fetch by id");
	assert.doesNotMatch(transferValidation, /storage\.validation_results\s*\[\s*platform_name\s*\]/,
		"validation result storage must not be platform-name keyed");
});

test("LuaInterface has no production validation-result refetch helper", () => {
	const luaInterface = fs.readFileSync(path.join(__dirname, "..", "lib", "lua-interface.ts"), "utf8");
	const removedHelperName = ["getValidationResult", "Json"].join("");
	assert.doesNotMatch(luaInterface, new RegExp(removedHelperName),
		"production TS should consume the Lua composite verdict payload instead of re-fetching stored validation by id");
});
test("fluid-loss hook is allowlisted and fires before the post-activation fluid gate", () => {
	const importCompletion = fs.readFileSync(path.join(moduleRoot, "core", "import-completion.lua"), "utf8");
	const configure = fs.readFileSync(path.join(moduleRoot, "interfaces", "remote", "configure.lua"), "utf8");
	const hookLint = fs.readFileSync(path.join(__dirname, "..", "scripts", "lint-test-hooks.mjs"), "utf8");
	const hookIndex = importCompletion.indexOf("test_force_fluid_loss");
	const gateIndex = importCompletion.indexOf("TransferValidation.validate_fluids_post_activation");

	assert.notEqual(hookIndex, -1, "import completion must consume test_force_fluid_loss");
	assert.ok(hookIndex < gateIndex, "test_force_fluid_loss must fire before the fluid gate");
	assert.match(importCompletion, /result\.expectedFluidCounts\[missing_key\]\s*=\s*\(result\.expectedFluidCounts\[missing_key\]\s*or\s*0\)\s*\+\s*expected_loss/,
		"hook should inflate expected fluids without mutating the destination");
	assert.match(importCompletion, /\[TEST HOOK\] Forced fluid loss: inflated missing expected/,
		"integration probe needs a direct log witness that the hook fired");
	assert.match(configure, /config\.test_force_fluid_loss[\s\S]*storage\.surface_export_config\.test_force_fluid_loss\s*=\s*config\.test_force_fluid_loss/,
		"configure allowlist must accept test_force_fluid_loss");
	assert.match(hookLint, /"test_force_fluid_loss"[\s\S]*pre-gate/,
		"test_force_fluid_loss must be explicitly listed as a reviewed fail-safe hook");
});