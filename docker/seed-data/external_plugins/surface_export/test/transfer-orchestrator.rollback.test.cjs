"use strict";
/**
 * Adversarial rollback test for the transfer two-phase commit (#80).
 *
 * The bug: `transferPlatform`'s catch unlocked the source on ANY rejection of the import `sendTo`. A
 * controller↔host **SessionLost** (link blip) is AMBIGUOUS — it does NOT prove the destination never got
 * the import — so unlocking there could leave a live source coexisting with a destination copy
 * (duplication). The fix routes a SessionLost into `awaiting_validation` (like the ACK path) instead of
 * unlocking; a genuine non-delivery error still rolls back.
 *
 * Grounding: this asserts WHICH protective route ran (unlock vs. arm-validation), not merely that a bad
 * outcome was absent — a green test that only checked "no crash" would pass on the broken code too. We spy
 * `tryUnlockSource` (the source-unlock route) and read the transfer's terminal state.
 *
 * Zero external deps: node:test + node:assert against the COMPILED output (dist/node), so run
 * `npm run build:node` first (the `npm test` script does).
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const distNode = path.join(__dirname, "..", "dist", "node");
const { TransferOrchestrator } = require(path.join(distNode, "lib", "transfer-orchestrator.js"));
const { isSessionLostError } = require(path.join(distNode, "helpers.js"));
const messages = require(path.join(distNode, "messages.js"));

/** A Clusterio SessionLost look-alike: a plain Error carrying `code = "SessionLost"`. */
function sessionLost(message = "Session Closed") {
	return Object.assign(new Error(message), { code: "SessionLost" });
}

/**
 * Minimal mock IControllerPlugin + orchestrator, driven just far enough to reach the import `sendTo`.
 * `importSendResult(msg)` decides what the ImportPlatformRequest send does (throw or resolve). We spy
 * `tryUnlockSource` to record whether the source-unlock (rollback) route was taken.
 */
function makeHarness(importSendResult, sourceSendResult = () => ({ success: true })) {
	const noop = () => {};
	const activeTransfers = new Map();
	const calls = { events: [], unlockRouteTaken: 0, importSends: 0, openPhases: new Set() };

	const plugin = {
		logger: { error: noop, warn: noop, info: noop },
		// #106 hooks the orchestrator calls on enter/exit of awaiting_validation (recorded for assertions).
		persistPendingTransfer: (intent) => { calls.pendingPersisted = intent; },
		removePendingTransfer: (id) => { calls.pendingRemoved = id; },
		persistStorage: async () => { calls.persistStorageCalls = (calls.persistStorageCalls || 0) + 1; },
		platformStorage: {
			get: () => ({
				exportData: { platform: { index: 3, force: "player" } },
				exportMetrics: null,
				platformName: "test-platform",
				platformIndex: 3,
				instanceId: 1,
				size: 123,
			}),
			delete: noop,
		},
		platformTree: { resolveInstanceName: (id) => `instance-${id}` },
		activeTransfers,
		txLogger: {
			logTransactionEvent: (_id, type) => { calls.events.push(type); },
			startPhase: (_id, name) => { calls.openPhases.add(name); },
			endPhase: (_id, name) => { calls.openPhases.delete(name); return 0; },
			persistTransactionLog: async () => {},
			buildPhaseSummary: () => ({}),
		},
		subscriptions: { emitTransferUpdate: noop, queueTreeBroadcast: noop },
		controller: {
			sendTo: async (_dst, msg) => {
				if (msg && msg.constructor && msg.constructor.name === "ImportPlatformRequest") {
					calls.importSends++;
					return importSendResult(msg);
				}
				return sourceSendResult(msg); // Delete/Unlock/StatusUpdate — default success; tests override.
			},
		},
	};

	const orch = new TransferOrchestrator(plugin, messages);
	// Spy the protective route WITHOUT running the real unlock send (mechanics tested elsewhere). The
	// The rollback-path tests below spy this method directly; sendUnlockRequest mechanics are covered by
	// integration paths rather than the retired restart-reconcile helper.
	orch.tryUnlockSource = async () => { calls.unlockRouteTaken++; return null; };
	return { orch, activeTransfers, calls, plugin };
}

function onlyTransfer(activeTransfers) {
	const all = [...activeTransfers.values()];
	assert.equal(all.length, 1, "exactly one transfer record expected");
	return all[0];
}

test("isSessionLostError: true only for code === 'SessionLost'", () => {
	assert.equal(isSessionLostError(sessionLost()), true);
	assert.equal(isSessionLostError(sessionLost("Session Lost")), true);
	assert.equal(isSessionLostError(new Error("network down")), false);
	assert.equal(isSessionLostError({ code: "OtherError" }), false);
	assert.equal(isSessionLostError(null), false);
	assert.equal(isSessionLostError("SessionLost"), false); // a bare string is not a session-loss error
});

test("SessionLost on import send: source NOT unlocked, transfer enters awaiting_validation (#80)", async () => {
	const { orch, activeTransfers, calls } = makeHarness(() => { throw sessionLost("Session Closed"); });

	const res = await orch.transferPlatform("export_1", 2);

	assert.equal(calls.importSends, 1, "the import send must have been attempted");
	// The load-bearing assertion: the source-unlock (rollback) route was NOT taken — no duplication window.
	assert.equal(calls.unlockRouteTaken, 0, "source must NOT be unlocked on an ambiguous SessionLost");

	const transfer = onlyTransfer(activeTransfers);
	assert.equal(transfer.status, "awaiting_validation", "must arm validation, not roll back");
	assert.ok(transfer.validationTimeout, "the validation timeout must be armed to resolve it later");
	assert.ok(calls.events.includes("import_delivery_uncertain"), "the uncertain-delivery route must be logged");
	// The "transmission" phase (opened before the failed send) must be CLOSED on the recovery path — else a
	// recovered+completed transfer reports blank transmission timing. "validation" is open while we wait.
	assert.equal(calls.openPhases.has("transmission"), false, "transmission phase must be closed on the recovery path");
	assert.equal(calls.openPhases.has("validation"), true, "validation phase is open while awaiting validation");

	assert.equal(res.success, true, "the transfer continues through the state machine");
	assert.ok(res.transferId, "a transferId is returned so the caller can track it");

	clearTimeout(transfer.validationTimeout); // don't leave the 2-minute timer holding the event loop open
});

test("Non-session-loss throw on import send: source IS rolled back (unlock route runs)", async () => {
	const { orch, activeTransfers, calls } = makeHarness(() => { throw new Error("malformed request"); });

	const res = await orch.transferPlatform("export_1", 2);

	assert.equal(calls.importSends, 1, "the import send must have been attempted");
	// A definite non-delivery error means the destination has nothing — the safe rollback must still run.
	assert.equal(calls.unlockRouteTaken, 1, "a definite non-delivery error must roll back (unlock) the source");

	const transfer = onlyTransfer(activeTransfers);
	assert.notEqual(transfer.status, "awaiting_validation", "a definite failure must not enter awaiting_validation");
	assert.equal(res.success, false);

	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);
});

test("#106: validation fails AND source unlock fails → cleanup_failed KEEPS the recovery intent (not dropped)", async () => {
	// Adversarial (review #106 orch:310, a CONFIRMED data-loss defect): reverting handleValidationFailure to
	// an unconditional status='failed' makes handleTransferValidation's removal condition DROP the persisted
	// intent while the source is STILL locked-and-hidden (the unlock failed) — so a later restart has nothing
	// to reconcile and the source is stranded forever. This test goes RED on that revert.
	const { orch, activeTransfers, calls } = makeHarness(() => { throw sessionLost("Session Closed"); });
	const res = await orch.transferPlatform("export_1", 2); // arm awaiting_validation (persists the intent)
	const transfer = onlyTransfer(activeTransfers);
	assert.equal(transfer.status, "awaiting_validation");
	assert.ok(calls.pendingPersisted, "the recovery intent was persisted on awaiting_validation");
	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);

	// The source UNLOCK fails (source briefly unreachable) — tryUnlockSource returns a non-null error string.
	orch.tryUnlockSource = async () => { calls.unlockRouteTaken++; return "unlock failed: source offline"; };
	calls.pendingRemoved = undefined;

	await orch.handleTransferValidation({ transferId: res.transferId, success: false, validation: { mismatchDetails: "item mismatch" } });

	assert.equal(transfer.status, "cleanup_failed", "failed validation + failed unlock must be cleanup_failed, not failed");
	assert.equal(calls.pendingRemoved, undefined, "the recovery intent must be KEPT until bounded retention pruning");
});

test("#106: validation fails but source unlock SUCCEEDS → failed drops the intent (source resolved)", async () => {
	// The symmetric happy path: a successful unlock DOES resolve the source, so the intent is correctly dropped.
	const { orch, activeTransfers, calls } = makeHarness(() => { throw sessionLost("Session Closed"); });
	const res = await orch.transferPlatform("export_1", 2);
	const transfer = onlyTransfer(activeTransfers);
	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);

	orch.tryUnlockSource = async () => { calls.unlockRouteTaken++; return null; }; // unlock succeeds
	calls.pendingRemoved = undefined;

	await orch.handleTransferValidation({ transferId: res.transferId, success: false, validation: { mismatchDetails: "item mismatch" } });

	assert.equal(transfer.status, "failed", "failed validation + successful unlock is 'failed'");
	assert.equal(calls.pendingRemoved, res.transferId, "the recovery intent is dropped once the source is unlocked");
});
