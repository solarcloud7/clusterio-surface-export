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
		// The orchestrator records a `start` row the moment a transfer is created, so a transfer
		// that never reaches a verdict still leaves evidence it existed. Counted, not ignored:
		// some tests assert it fired.
		recordTransferStarted: async () => { calls.startRows = (calls.startRows || 0) + 1; },
		txLogger: {
			logTransactionEvent: noop,
			archiveRecycledTransferId() {},
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
	// 2.1 registry port: restore now takes the payload's fluid-segment registry as a third arg.
	const injectAt = importCompletion.indexOf("FluidRestoration.restore(entities_to_create, entity_map,", heldAt);
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
	assert.match(transferValidation, /SurfaceCounter\.count_fluids\s*\(\s*surface\s*,\s*options\.segment_temps\s*\)/,
		"the exact census must receive injection segment temperatures (2.1 registry: no ownership-exclusion arg)");
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

test("failed-entity ITEMS are subtracted, failed-entity FLUIDS are not, and only write_rejected adjusts fluids pre-gate", () => {
	const importCompletion = fs.readFileSync(path.join(moduleRoot, "core", "import-completion.lua"), "utf8");
	// Failed-entity ITEM losses are subtracted from expected before the gate: a failed placement can't
	// hold its items, so counting them as expected would be a false shortfall.
	const felItemsAt = importCompletion.indexOf("pairs(fel.items)");
	const felGateAt = importCompletion.indexOf("TransferValidation.validate_import", felItemsAt);
	assert.ok(felItemsAt !== -1 && felGateAt > felItemsAt,
		"failed-entity item losses must adjust expected item counts before the verdict");
	// Failed-entity FLUIDS are DELIBERATELY not subtracted (owner ruling 2026-07-20, "fail => revert"):
	// a segment short of a failed member's share must FAIL the exact gate so the two-phase commit
	// preserves the source. There is no failed-member fluid accounting.
	assert.doesNotMatch(importCompletion, /fel\.fluids/,
		"failed-entity fluids must NOT be subtracted — a short segment fails the exact gate (fail => revert)");
	// The ONLY lawful fluid subtraction is write_rejected — a PHYSICAL post-write measurement, not a
	// category prediction — and it must land before the single exact gate.
	const rejectedAt = importCompletion.indexOf("write_rejected");
	const gateAt = importCompletion.indexOf("TransferValidation.validate_import", rejectedAt);
	assert.ok(rejectedAt !== -1 && gateAt > rejectedAt,
		"physically-measured write_rejected must adjust expected fluids before the verdict");
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
	const hookLint = fs.readFileSync(path.join(__dirname, "..", "scripts", "lint-test-hooks.mjs"), "utf8"); // reads the LINT (flag-coverage assertions); the hook ENUMERATION lives in fail-safe-hooks.mjs
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
		"passenger evacuation must be pcall-protected — a raw error() in event context kills the "
		+ "headless server. Its FAILURE no longer blocks the delete (see the discard-contract test).");
});

test("the discard contract is unconditional — observability and guards never gate it", () => {
	// Owner ruling 2026-08-02. First shipped as prose assertions (matching log() strings), and the
	// review MUTATION-TESTED them: re-nesting the delete inside the evacuation branch passed, and
	// reinstating preserve-on-bank-failure with different wording passed. Three of four claims had
	// no teeth. These are CONTROL-FLOW assertions now — they pin the shapes those two mutations
	// changed, with the prose kept only as secondary documentation.
	const importCompletion = fs.readFileSync(path.join(moduleRoot, "core", "import-completion.lua"), "utf8");

	// Anchor the failure-discard block once; every segment below is carved from real positions so a
	// vanished anchor fails loudly instead of matching elsewhere in the file.
	const bankAt = importCompletion.indexOf("pcall(bank_failure_black_box");
	const configAt = importCompletion.indexOf("local config = storage.surface_export_config", bankAt);
	const evacuateAt = importCompletion.indexOf("pcall(Gateway.evacuate_passengers", bankAt);
	const deleteAt = importCompletion.indexOf("pcall(GameUtils.delete_platform", bankAt);
	assert.ok(bankAt !== -1 && configAt > bankAt && evacuateAt > configAt && deleteAt > evacuateAt,
		"the failure-discard block must keep its shape: bank -> config/preserve -> evacuate -> delete");

	// 1. Black-box write failure must not GATE anything. Problem class the old branch was installed
	//    against: evidence loss. Re-covered: on failure the SOURCE is preserved (fail => revert), so
	//    the authoritative evidence still exists; the black box is a convenience copy.
	//    CONTROL FLOW: between the bank pcall and the preserve/config block there is no early return
	//    and no verdict mutation — a bank failure can only log. (This catches the review's Mutation
	//    B, which reinstated the preserve with different wording.)
	const bankSegment = importCompletion.slice(bankAt, configAt);
	assert.doesNotMatch(bankSegment, /\breturn\b/,
		"a bank failure must not exit the discard block — observability never gates the contract");
	assert.doesNotMatch(bankSegment, /cleanup_failed|destinationPreserved/,
		"a bank failure must not mutate the verdict — it may only log");

	// 2. The evacuation guard's failure must not BLOCK the delete. Problem class: player harm on
	//    delete-with-passenger. Re-covered: the engine natively returns a player to a planet on hub
	//    loss; evacuation is still attempted first.
	//    CONTROL FLOW: the delete is a DIRECT pcall assignment, not nested under `if evacuated`.
	//    (This catches the review's Mutation A, which re-nested it with the log lines untouched.)
	const evacuateSegment = importCompletion.slice(evacuateAt, deleteAt);
	assert.doesNotMatch(evacuateSegment, /if\s+evacuated\s+then/,
		"the delete must not be conditioned on evacuation success — that guard manufactured the "
		+ "orphan it guarded against");
	assert.doesNotMatch(evacuateSegment, /\breturn\b/,
		"nor may an evacuation failure EXIT before the delete — an `if not evacuated then return` "
		+ "re-gate is the same orphan through the other door (reconciliation-review note)");
	assert.match(importCompletion.slice(deleteAt - 60, deleteAt + 50),
		/local\s+delete_ok\s*,\s*delete_result\s*=\s*pcall\(GameUtils\.delete_platform/,
		"the delete must be an unconditional direct pcall assignment");

	// 3. An already-invalid platform is a COMPLETED discard, and it must be decided BEFORE the
	//    preserve flag so an armed one-shot is not burned on nothing.
	const invalidAt = importCompletion.indexOf("nothing to discard", bankAt);
	const consumeAt = importCompletion.indexOf("config.preserve_failed_destination = nil", bankAt);
	assert.ok(invalidAt !== -1 && consumeAt !== -1 && invalidAt < consumeAt,
		"the validity branch must precede the preserve branch — an invalid platform must not consume "
		+ "the one-shot flag");
	assert.doesNotMatch(importCompletion.slice(invalidAt, consumeAt), /=\s*nil/,
		"the nothing-to-discard branch must not consume the preserve flag");

	// Secondary prose markers (documentation, not the teeth).
	assert.match(importCompletion, /discarding the destination anyway/);
	assert.match(importCompletion, /proceeding[\s\S]{0,40}with discard/);
	assert.doesNotMatch(importCompletion, /cleanup_error\s*=\s*string\.format\("Failed to bank failure black box/);

	// What remains of cleanup_failed on this path is the one honest residual: the engine itself
	// refused the delete, so an orphaned surface really exists.
	assert.match(importCompletion, /GameUtils\.delete_platform failed/,
		"a real engine delete failure must still be reported — an orphan genuinely exists then");
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

// RETIRED (2.1 fluid-segment registry, owner ruling 2026-07-20): the `engine_owned` connection-category
// classification is DELETED — plasma rides transfers like any fluid; the only lawful fluid subtraction is
// physically-measured `write_rejected` (guarded above). The two former tests here asserted the symmetry of
// that deleted classification across export/restore/census and the strict census's engine-owned exclusion.
// The surviving epsilon/no-band invariant is guarded by "single gate is exact for items and by-name fluids".

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
	const hookLint = fs.readFileSync(path.join(__dirname, "..", "scripts", "fail-safe-hooks.mjs"), "utf8"); // FAIL_SAFE_HOOKS moved to the shared declaration
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

// RETIRED (2.1 fluid-segment registry): the P2 plasma measurement hook (`test_capture_p2_plasma`) was a
// 2.0.77 fluid-lab instrument for the buffer/window duality that no longer exists at 2.1 — plasma is no
// longer special (owner ruling 2026-07-20). Its consumer is gone from import-completion; the hook is deleted.

// REWRITTEN 2026-07-27 (owner order: legacy purge): the consolidation restore, hub-deficit
// recovery, and the first-fit fallback are DELETED. attribute_lines survives as the
// black box's forensic instrument; the production restore contract is captured-source-position placement with a shape
// validator guarding the on_tick path (review F1) and anomalies failing every import path (F2).
test("belt forensic census survives the legacy purge; recovery machinery is gone", () => {
	const restoration = fs.readFileSync(path.join(moduleRoot, "import_phases", "belt_restoration.lua"), "utf8");
	assert.match(restoration, /function BeltRestoration\.attribute_lines\s*\(/,
		"the black box's per-line expected-vs-actual attribution must remain independently repeatable");
	assert.match(restoration, /entity\.unit_number[\s\S]*line_index[\s\S]*expected[\s\S]*actual[\s\S]*delta/,
		"attribution rows must name a physical entity and line with both sides of the comparison");
	assert.match(restoration, /attribution\.actual_total\s*-\s*attribution\.expected_total/,
		"the forensic total must come from the completed physical census, not insert return values");
	assert.match(restoration, /OVER-COMPRESSION MERGE/,
		"the restored over-compression merge must stay PRESENT - deleting it re-opens the 2026-07-27 incident (a purge must account for this class)");
	assert.match(restoration, /local function scan_place[\s\S]{0,900}?can_insert_at\(k \/ 256\)[\s\S]{0,160}?and VersionCompat\.belt_insert_at\(/,
		"the merge's scan must gate every landing on the engine's insert return - a can_insert_at-only scan reports landings that never happened (review 2026-08-09)");
	assert.doesNotMatch(restoration, /recover_deficits_to_hub|function BeltRestoration\.restore\s*\(|line_needs_consolidation|MIN_SPACING/,
		"the legacy consolidation restore and hub-deficit recovery must stay deleted (owner order 2026-07-27)");
});
test("source-position restore is guarded on the on_tick path and anomalies fail every import", () => {
	const restoration = fs.readFileSync(path.join(moduleRoot, "import_phases", "belt_restoration.lua"), "utf8");
	const completion = fs.readFileSync(path.join(moduleRoot, "core", "import-completion.lua"), "utf8");
	assert.match(restoration, /function BeltRestoration\.validate_side_groups\s*\(/,
		"the shape validator must exist — an uncaught throw on the import's on_tick path kills the server");
	assert.match(restoration, /item_source_positions missing or misaligned[\s\S]*payloads without captured source positions are no longer importable/,
		"item_source_positions must be REQUIRED: a payload without it is refused, never routed to a fallback");
	assert.match(completion, /validate_side_groups\(side_groups\)/,
		"the import must shape-validate belt_side_groups before restoring");
	assert.match(completion, /local restore_fn = BeltRestoration\.restore_side_groups[\s\S]{0,200}?pcall\(restore_fn/,
		"the restore call must be pcall-wrapped: a throw becomes a verdict refusal, never server death");
	assert.match(completion, /belt_anomalies[\s\S]*failedStage = result\.failedStage or "belts"/,
		"belt anomalies must refuse the transfer verdict without clobbering an earlier failure stage");
	assert.match(completion, /not \(is_transfer and has_verification\)[\s\S]*belt_anomalies[\s\S]*failedStage = "belts"/,
		"belt anomalies must fail NON-transfer imports too (upload/clone) — never a silent success");
	assert.match(completion, /predates captured source positions/,
		"a legacy payload carrying belt items without side groups must be refused loudly");
});
test("failed transfer banks gate-time belt attribution and replayable payload", () => {
	const completion = fs.readFileSync(path.join(moduleRoot, "core", "import-completion.lua"), "utf8");
	assert.match(completion, /belt_lines\s*=\s*BeltRestoration\.attribute_lines/,
		"failure black box must refresh attribution at the frozen gate point");
	assert.match(completion, /replay_payload\s*=\s*job\.platform_data/,
		"every failed transfer must bank its exact replayable serialized input");
});