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
const { createOperationRecord } = require(path.join(distNode, "lib", "operation-record.js"));
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

test("instance forwards Lua single verdict payload without name-keyed refetch or re-derivation", async () => {
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
	assert.equal(calls.sent[0].success, false, "payload success is the authoritative single verdict");
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

test("instance fails closed when Lua omits the boolean success verdict", async () => {
	const { plugin, calls } = makeInstanceHarness();

	await plugin.handleImportCompleteValidation({
		platform_name: "Missing Boolean Verdict",
		transfer_id: "1:001_missing_boolean",
		source_instance_id: 1,
		validation: { itemCountMatch: true, fluidCountMatch: true },
	});

	assert.equal(calls.sent.length, 1);
	assert.equal(calls.sent[0].success, false, "missing data.success must fail closed despite matching counts");
});

test("transfer operation records reject a missing platform index", () => {
	assert.throws(() => createOperationRecord("transfer", {
		operationId: "transfer:missing-index",
		platformName: "test",
		sourceInstanceId: 1,
		targetInstanceId: 2,
	}), /platformIndex/i);
	for (const platformIndex of [null, 0, -1]) {
		assert.throws(() => createOperationRecord("transfer", {
			operationId: `transfer:invalid-index:${platformIndex}`,
			platformName: "test",
			platformIndex,
			sourceInstanceId: 1,
			targetInstanceId: 2,
		}), /platformIndex/i);
	}
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

test("orchestrator preserves failedStage from the single verdict on failed transfers", async () => {
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

test("orchestrator surfaces a failed destination discard as cleanup_failed", async () => {
	const { orch, transfer } = makeTransferHarness();

	await orch.handleTransferValidation({
		transferId: transfer.transferId,
		success: false,
		platformName: transfer.platformName,
		sourceInstanceId: transfer.sourceInstanceId,
		validation: {
			itemCountMatch: false,
			fluidCountMatch: true,
			failedStage: "items",
			mismatchDetails: "Item gate failed",
			cleanup_failed: true,
			cleanup_error: "GameUtils.delete_platform returned false",
		},
	});

	assert.equal(transfer.status, "cleanup_failed");
	assert.match(transfer.error, /delete_platform returned false/);
});

test("operation outcome metrics expose bounded failure_stage label", () => {
	const operationsMetric = metricDefinitions.find(def => def.name === "surface_export_operations_total");
	assert.ok(operationsMetric, "operations total metric should be registered");
	assert.deepEqual(operationsMetric.options.labels, ["operation", "result", "failure_stage"]);
});

test("Lua import completion injects fluids and renders one verdict before activation", () => {
	const importCompletion = fs.readFileSync(path.join(moduleRoot, "core", "import-completion.lua"), "utf8");
	const heldAt = importCompletion.indexOf("ActiveStateRestoration.restore_held_items_only");
	const injectAt = importCompletion.indexOf("FluidRestoration.restore(entities_to_create, entity_map)", heldAt);
	const gateAt = importCompletion.indexOf("TransferValidation.validate_import", injectAt);
	const activateAt = importCompletion.indexOf("ActiveStateRestoration.restore(job.entities_to_create", gateAt);
	assert.ok(heldAt !== -1 && injectAt > heldAt, "frozen fluid injection must follow held-item completion");
	assert.ok(gateAt > injectAt, "the complete-world census must follow frozen fluid injection");
	assert.ok(activateAt > gateAt, "activation must remain strictly after the one verdict");
	assert.doesNotMatch(importCompletion, /validate_fluids_post_activation/,
		"no post-activation verdict writer may remain");
	assert.doesNotMatch(importCompletion, /test_measure_frozen_fluid_injection|r11FrozenFluidMeasurement/,
		"the R11 measurement seam must retire when its body becomes production ordering");
});

test("single gate is exact for items and by-name fluids", () => {
	const transferValidation = fs.readFileSync(path.join(moduleRoot, "validators", "transfer-validation.lua"), "utf8");
	assert.match(transferValidation, /function\s+aggregate_fluid_counts_by_name\s*\(/,
		"fluid parity must aggregate temperatures by fluid name");
	assert.match(transferValidation, /EXACT_EPSILON\s*=\s*1e-6/,
		"the only fluid comparison nuance is serializer-scale floating representation");
	assert.doesNotMatch(transferValidation, /STRICT_ABS|STRICT_PCT|FLUID_GAIN_TOLERANCE|FLUID_LOSS_TOLERANCE/,
		"destructive transfer parity must contain no band, floor, or percentage tolerance");
	assert.match(transferValidation, /SurfaceCounter\.count_fluids\s*\(\s*surface\s*,\s*options\.segment_temps\s*,\s*strict\s*\)/,
		"the exact census must receive injection segment temperatures and strict ownership exclusion");
});

test("failed single gate banks an always-on black box before discard", () => {
	const importCompletion = fs.readFileSync(path.join(moduleRoot, "core", "import-completion.lua"), "utf8");
	const bankAt = importCompletion.indexOf("bank_failure_black_box");
	const discardAt = importCompletion.indexOf("GameUtils.delete_platform", bankAt);
	assert.ok(bankAt !== -1 && discardAt > bankAt, "black-box evidence must be banked before destination discard");
	assert.match(importCompletion, /preserve_failed_destination/,
		"debug-gated preserve mode must remain an explicit escape hatch");
	assert.doesNotMatch(importCompletion, /quarantine_destination_after_discard_failure|destinationDiscard(?:ed|Escalated|Quarantined|QuarantineError)/,
		"retired quarantine and consumer-less destination fields must be gone");
});

test("failed-entity fluids and engine-rejected writes adjust expectations before the gate", () => {
	const importCompletion = fs.readFileSync(path.join(moduleRoot, "core", "import-completion.lua"), "utf8");
	const failedFluidsAt = importCompletion.indexOf("fel.fluids");
	const rejectedAt = importCompletion.indexOf("write_rejected", failedFluidsAt);
	const gateAt = importCompletion.indexOf("TransferValidation.validate_import", rejectedAt);
	assert.ok(failedFluidsAt !== -1 && rejectedAt > failedFluidsAt && gateAt > rejectedAt,
		"failed-entity fluids and rejected writes must adjust expected counts before the verdict");
});

test("failed-entity and overflow item losses retain quality keys end to end", () => {
	const entityCreation = fs.readFileSync(path.join(moduleRoot, "import_phases", "entity_creation.lua"), "utf8");
	const deserializer = fs.readFileSync(path.join(moduleRoot, "core", "deserializer.lua"), "utf8");
	const importCompletion = fs.readFileSync(path.join(moduleRoot, "core", "import-completion.lua"), "utf8");
	assert.match(entityCreation, /Util\.make_quality_key\(item\.name,\s*item\.quality/,
		"failed-entity inventory losses must use the exported item quality");
	assert.match(entityCreation, /Util\.make_quality_key\(held\.name,\s*held\.quality/,
		"failed-entity held-item losses must use the exported item quality");
	const entityQualityKeys = entityCreation.match(/Util\.make_quality_key\(/g) || [];
	assert.equal(entityQualityKeys.length, 4,
		"ground, inventory, belt, and held-item loss paths must each preserve quality");
	assert.match(deserializer, /Util\.make_quality_key\(item\.name,\s*item\.quality/,
		"overflow losses must use the exported item quality");
	assert.match(importCompletion, /adjusted_verification\.item_counts\[item_key\]/,
		"quality-keyed losses must be subtracted from the same expected-count key");
});

test("forced entity failure is fail-safe and preservation is one-shot and visible", () => {
	const entityCreation = fs.readFileSync(path.join(moduleRoot, "import_phases", "entity_creation.lua"), "utf8");
	const importCompletion = fs.readFileSync(path.join(moduleRoot, "core", "import-completion.lua"), "utf8");
	const hookLint = fs.readFileSync(path.join(__dirname, "..", "scripts", "lint-test-hooks.mjs"), "utf8");
	assert.match(entityCreation, /job\.test_forced_entity_failure\s*=\s*true/,
		"the mutating entity hook must leave a fail-safe verdict marker");
	assert.match(importCompletion, /job\.test_forced_entity_failure[\s\S]*result\.success\s*=\s*false/,
		"a leaked entity-failure hook must fail the transfer and preserve the source");
	assert.match(importCompletion, /config\.preserve_failed_destination\s*=\s*nil/,
		"debug destination preservation must be consumed when it fires");
	assert.match(importCompletion, /destinationPreserved\s*=\s*true/,
		"intentional preservation must be visible in the verdict");
	assert.match(hookLint, /preserve_failed_destination/,
		"the persistent mutating debug flag must be covered by the hook lint");
});

test("failed destination discard evacuates passengers before deletion", () => {
	const importCompletion = fs.readFileSync(path.join(moduleRoot, "core", "import-completion.lua"), "utf8");
	const failureAt = importCompletion.indexOf("if not validation_result.success then");
	const evacuateAt = importCompletion.indexOf("Gateway.evacuate_passengers", failureAt);
	const discardAt = importCompletion.indexOf("GameUtils.delete_platform", failureAt);
	assert.ok(evacuateAt > failureAt && discardAt > evacuateAt,
		"black-box discard must route passengers through evacuation before deleting the destination");
	assert.match(importCompletion.slice(evacuateAt, discardAt), /pcall/,
		"passenger evacuation must be protected so a failure preserves the destination");
});

test("exact fluid parity is strict-transfer-only", () => {
	const transferValidation = fs.readFileSync(path.join(moduleRoot, "validators", "transfer-validation.lua"), "utf8");
	assert.match(transferValidation, /validate_fluid_counts\([^)]*strict/,
		"fluid validation must receive the strict-transfer decision");
	assert.match(transferValidation, /if\s+strict\s+then[\s\S]*EXACT_EPSILON/,
		"exact epsilon belongs to the strict transfer branch");
	assert.match(transferValidation, /validate_fluid_counts\([\s\S]*strict\s*\)/,
		"validate_import must pass strictness into fluid validation");
});

test("fluid reconciliation uses one emitted key across Lua, DTO, and CLI", () => {
	const lossAnalysis = fs.readFileSync(path.join(moduleRoot, "validators", "loss-analysis.lua"), "utf8");
	const dto = fs.readFileSync(path.join(__dirname, "..", "shared", "dto.ts"), "utf8");
	const cliPath = path.join(__dirname, "..", "..", "..", "..", "..", "tools", "get-transaction-log.ps1");
	const sources = [lossAnalysis, dto];
	if (fs.existsSync(cliPath)) sources.push(fs.readFileSync(cliPath, "utf8"));
	for (const source of sources) {
		assert.match(source, /reconciledLoss/, "all forensic layers must read the Lua-emitted key");
		assert.doesNotMatch(source, /reconciledFluidLoss/, "the stale key must not silently render loss as zero");
	}
});

test("fluid-loss configuration coerces unsafe input and debug result emits once", () => {
	const configure = fs.readFileSync(path.join(moduleRoot, "interfaces", "remote", "configure.lua"), "utf8");
	const importCompletion = fs.readFileSync(path.join(moduleRoot, "core", "import-completion.lua"), "utf8");
	assert.match(configure, /tonumber\(config\.test_force_fluid_loss\)/,
		"non-numeric debug input must not crash import completion");
	const emits = importCompletion.match(/\n\s*emit_debug_import_result\(job, validation_result, duration_seconds\)/g) || [];
	assert.equal(emits.length, 1, "debug import result must be emitted once per completion tick");
});

test("fluid restoration reports dropped fluids without subtracting them", () => {
	const restoration = fs.readFileSync(path.join(moduleRoot, "import_phases", "fluid_restoration.lua"), "utf8");
	assert.match(restoration, /return\s*\{[\s\S]*dropped_fluids\s*=\s*dropped_fluids[\s\S]*\}/,
		"capacity or partial-insert drops must be returned for diagnosis");
	const importCompletion = fs.readFileSync(path.join(moduleRoot, "core", "import-completion.lua"), "utf8");
	assert.doesNotMatch(importCompletion, /expected_fluids_after_[^(]*drops|subtract[^\n]*dropped_fluids/i,
		"real dropped fluid must fail exact parity, never be subtracted from expected");
});

test("engine-owned fluid classification is symmetric across export, restore, and census", () => {
	const scanner = fs.readFileSync(path.join(moduleRoot, "export_scanners", "inventory-scanner.lua"), "utf8");
	const ownership = fs.readFileSync(path.join(moduleRoot, "utils", "fluid-ownership.lua"), "utf8");
	const verification = fs.readFileSync(path.join(moduleRoot, "validators", "verification.lua"), "utf8");
	const restoration = fs.readFileSync(path.join(moduleRoot, "import_phases", "fluid_restoration.lua"), "utf8");
	const counter = fs.readFileSync(path.join(moduleRoot, "validators", "surface-counter.lua"), "utf8");
	assert.match(ownership, /pipe_connections[\s\S]*connection_category/,
		"classification must derive ownership from the engine's fluid connection categories");
	assert.match(ownership, /category\s*==\s*["']default["']/,
		"any box accepting the player-pipe default category must remain accountable");
	assert.doesNotMatch(ownership, /ENGINE_MANAGED_OUTPUT_ENTITIES|\[["']fusion-reactor["']\]/,
		"classification must not hardcode a prototype allowlist");
	assert.match(ownership, /WARNING[\s\S]*connection categor/i,
		"future non-fusion categories must trip a loud export warning");
	assert.match(scanner, /engine_owned\s*=\s*engine_owned/,
		"serialized fluid records must retain the informational engine-owned classification");
	assert.match(verification, /if\s+not\s+fluid\.engine_owned/,
		"engine-owned records must be excluded from expected verification counts");
	assert.match(restoration, /if\s+fluid_data\.engine_owned/,
		"import must skip engine-owned writes rather than infer acceptance from readback");
	assert.match(counter, /exclude_engine_owned[\s\S]*collect_engine_owned_segments/,
		"gate census must independently apply the same engine-owned segment classification");
});

test("exact transfer gate requests engine-owned exclusion without changing epsilon", () => {
	const validation = fs.readFileSync(path.join(moduleRoot, "validators", "transfer-validation.lua"), "utf8");
	assert.match(validation, /SurfaceCounter\.count_fluids\s*\([^)]*strict\s*\)/,
		"strict transfer census must exclude engine-owned fluid");
	assert.match(validation, /EXACT_EPSILON\s*=\s*1e-6/);
});

test("post-activation reporting cannot overwrite frozen gate fields", () => {
	const lossAnalysis = fs.readFileSync(path.join(moduleRoot, "validators", "loss-analysis.lua"), "utf8");
	assert.match(lossAnalysis, /result\.postActivationReport\s*=\s*{/,
		"post-activation physical reporting must live under a separate sub-object");
	assert.doesNotMatch(lossAnalysis, /validation_result\.actualItemCounts\s*=|validation_result\.actualFluidCounts\s*=/,
		"reporting must not mutate the gate's immutable actual counts");
});

test("LuaInterface has no production validation-result refetch helper", () => {
	const luaInterface = fs.readFileSync(path.join(__dirname, "..", "lib", "lua-interface.ts"), "utf8");
	const removedHelperName = ["getValidationResult", "Json"].join("");
	assert.doesNotMatch(luaInterface, new RegExp(removedHelperName),
		"production TS should consume the Lua single verdict payload instead of re-fetching stored validation by id");
});
test("fluid-loss hook is allowlisted and fires before the single gate", () => {
	const importCompletion = fs.readFileSync(path.join(moduleRoot, "core", "import-completion.lua"), "utf8");
	const configure = fs.readFileSync(path.join(moduleRoot, "interfaces", "remote", "configure.lua"), "utf8");
	const hookLint = fs.readFileSync(path.join(__dirname, "..", "scripts", "lint-test-hooks.mjs"), "utf8");
	const hookIndex = importCompletion.indexOf("test_force_fluid_loss");
	const gateIndex = importCompletion.indexOf("TransferValidation.validate_import");

	assert.notEqual(hookIndex, -1, "import completion must consume test_force_fluid_loss");
	assert.ok(hookIndex < gateIndex, "test_force_fluid_loss must fire before the single gate");
	assert.match(importCompletion, /adjusted_verification\.fluid_counts\[missing_key\]\s*=\s*\(adjusted_verification\.fluid_counts\[missing_key\]\s*or\s*0\)\s*\+\s*expected_loss/,
		"hook should inflate expected fluids without mutating the destination");
	assert.match(importCompletion, /\[TEST HOOK\] Forced fluid loss: inflated missing expected/,
		"integration probe needs a direct log witness that the hook fired");
	assert.match(configure, /config\.test_force_fluid_loss[\s\S]*storage\.surface_export_config\.test_force_fluid_loss\s*=\s*tonumber\(config\.test_force_fluid_loss\)/,
		"configure allowlist must accept test_force_fluid_loss");
	assert.match(hookLint, /"test_force_fluid_loss"[\s\S]*pre-gate/,
		"test_force_fluid_loss must be explicitly listed as a reviewed fail-safe hook");
});

test("P2 plasma measurement hook is unique-name-scoped, one-shot, and pre-gate only", () => {
	const configure = fs.readFileSync(path.join(moduleRoot, "interfaces", "remote", "configure.lua"), "utf8");
	const importCompletion = fs.readFileSync(path.join(moduleRoot, "core", "import-completion.lua"), "utf8");
	const restoreAt = importCompletion.indexOf("FluidRestoration.restore(entities_to_create, entity_map)");
	const captureAt = importCompletion.indexOf("test_capture_p2_plasma", restoreAt);
	const gateAt = importCompletion.indexOf("TransferValidation.validate_import", captureAt);

	assert.match(configure, /config\.test_capture_p2_plasma[\s\S]*storage\.surface_export_config\.test_capture_p2_plasma/,
		"configure must register the P2 arming key instead of silently dropping it");
	assert.ok(restoreAt !== -1 && captureAt > restoreAt && gateAt > captureAt,
		"P2 must capture the production restore readback before the frozen exact gate");
	assert.match(importCompletion, /test_capture_p2_plasma\s*=\s*nil/,
		"the measurement hook must consume itself when the unique platform matches");
	assert.match(importCompletion, /platform_name\s*==\s*job\.platform_name/,
		"an unrelated transfer must never consume or fire the hook");
	assert.match(importCompletion, /storage\.fluid_lab\.p2_capture/,
		"the runner needs a positive same-tick capture witness");
	assert.doesNotMatch(importCompletion, /p2_capture[\s\S]{0,300}(?:result\.success|success\s*=\s*false)/,
		"the diagnostic hook must not alter the transfer verdict");
});

test("belt diagnostics census complete restored lines", () => {
	const restoration = fs.readFileSync(path.join(moduleRoot, "import_phases", "belt_restoration.lua"), "utf8");
	assert.match(restoration, /function BeltRestoration\.attribute_lines\s*\(/,
		"belt attribution must be independently repeatable at restore and gate time");
	assert.match(restoration, /entity\.unit_number[\s\S]*line_index[\s\S]*expected[\s\S]*actual[\s\S]*delta/,
		"attribution rows must name a physical entity and line with both sides of the comparison");
	assert.match(restoration, /attribution\.actual_total\s*-\s*attribution\.expected_total/,
		"the diagnostic total must come from the completed physical census, not insert return values");
});
test("failed transfer banks gate-time belt attribution and replayable payload", () => {
	const completion = fs.readFileSync(path.join(moduleRoot, "core", "import-completion.lua"), "utf8");
	assert.match(completion, /job\.belt_attribution\s*=\s*belts_result\s+and\s+belts_result\.attribution/,
		"restore-time attribution must survive until the frozen verdict");
	assert.match(completion, /belt_lines\s*=\s*BeltRestoration\.attribute_lines/,
		"failure black box must refresh attribution at the frozen gate point");
	assert.match(completion, /replay_payload\s*=\s*job\.platform_data/,
		"every failed transfer must bank its exact replayable serialized input");
});