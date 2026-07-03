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
function makeHarness(importSendResult) {
	const noop = () => {};
	const activeTransfers = new Map();
	const calls = { events: [], unlockRouteTaken: 0, importSends: 0 };

	const plugin = {
		logger: { error: noop, warn: noop, info: noop },
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
			startPhase: noop,
			endPhase: () => 0,
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
				return { success: true };
			},
		},
	};

	const orch = new TransferOrchestrator(plugin, messages);
	// Spy the protective route WITHOUT running the real unlock send (mechanics tested elsewhere).
	orch.tryUnlockSource = async () => { calls.unlockRouteTaken++; return null; };
	return { orch, activeTransfers, calls };
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
