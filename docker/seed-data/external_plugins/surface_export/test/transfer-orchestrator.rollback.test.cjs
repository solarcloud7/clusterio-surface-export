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
		// The transfer preflight (owner ruling 2026-08-02) refuses an offline destination up front.
		// Online by default so every pre-existing scenario reaches the code it was written to test.
		isInstanceOnline: (id) => (calls.offlineInstances ? !calls.offlineInstances.has(id) : true),
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
	// integration paths (recovery is the source-side TTL — there is no restart-reconcile helper).
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

test("#106: validation fails AND source unlock fails → status is plain 'failed', intent still KEPT", async () => {
	// The #106 protection, re-keyed (owner ruling 2026-08-02). The DEFECT #106 guards against is
	// dropping the persisted intent while the source is still locked-and-hidden — losing the
	// observability record for a source only the source-side TTL will recover. The old code proved
	// "source unresolved" by proxy: it flipped the STATUS to cleanup_failed so the status-keyed
	// removal condition wouldn't fire. The ruling reserves cleanup_failed for an actual leftover
	// platform (a TTL-recoverable lock leaves nothing behind), so the intent-keeping now keys on the
	// CONDITION itself — handleValidationFailure returns sourceResolved:false. This test goes RED if
	// either half regresses: the status decoration coming back, OR the intent being dropped.
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

	assert.equal(transfer.status, "failed",
		"a failed unlock is TTL-self-healing and leaves no platform behind — it must not wear the "
		+ "leftover-platform status");
	assert.match(String(transfer.error), /unlock failed: source offline/,
		"the unlock failure still rides in the error text");
	assert.equal(calls.pendingRemoved, undefined, "the recovery intent must be KEPT until bounded retention pruning");
});

test("a failed DESTINATION discard is cleanup_failed — a platform was left behind", async () => {
	// The one meaning cleanup_failed retains on the failure path: the Lua side reports the discard
	// itself failed (validation.cleanup_failed), so an orphaned half-built platform exists on the
	// target. Distinct from the unlock case above: something real is left for an operator.
	const { orch, activeTransfers, calls } = makeHarness(() => { throw sessionLost("Session Closed"); });
	const res = await orch.transferPlatform("export_1", 2);
	const transfer = onlyTransfer(activeTransfers);
	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);

	orch.tryUnlockSource = async () => { calls.unlockRouteTaken++; return null; }; // unlock succeeds
	calls.pendingRemoved = undefined;

	await orch.handleTransferValidation({ transferId: res.transferId, success: false, validation: {
		mismatchDetails: "item mismatch",
		cleanup_failed: true,
		cleanup_error: "GameUtils.delete_platform failed: returned false",
	} });

	assert.equal(transfer.status, "cleanup_failed");
	assert.match(String(transfer.error), /delete_platform failed/);
	assert.equal(calls.pendingRemoved, res.transferId,
		"the SOURCE is resolved (unlocked), so the intent is dropped — the orphan is on the target "
		+ "side and stays visible through the cleanup_failed record itself");
});

test("preflight: an offline destination is refused BEFORE any record exists", async () => {
	// Owner ruling 2026-08-02, case 1: prevent the failure, don't build recovery for it. The refusal
	// must happen before the ActiveTransfer record is created — a record would burn the canonical ID
	// and put a phantom entry in front of the retry guard.
	const { orch, activeTransfers, calls } = makeHarness(() => {
		throw new Error("import send must never be reached when the preflight refuses");
	});
	calls.offlineInstances = new Set([2]);

	const res = await orch.transferPlatform("export_1", 2);

	assert.equal(res.success, false);
	assert.match(String(res.error), /offline/, "the player-facing message names the cause");
	assert.match(String(res.error), /unchanged/, "and says the source platform is safe");
	assert.equal(res.safeToUnlockSource, true,
		"the refusal must carry the unlock authority: nothing was sent, so the CALLERS — the "
		+ "instance's refusal path AND handleStartPlatformTransferRequest, whichever holds the "
		+ "source lock — may release it. (Review finding: without this flag the web/ctl path "
		+ "stranded its export-time lock for the full TTL.)");
	assert.equal(activeTransfers.size, 0,
		"NO record: a refused preflight must not burn the canonical ID or feed the retry guard");
	assert.equal(calls.importSends, 0, "nothing was sent anywhere");
	assert.equal(calls.unlockRouteTaken, 0,
		"transferPlatform itself does not unlock on the preflight — the LOCK HOLDER does, keyed on "
		+ "safeToUnlockSource (the instance path and the web path lock at different times, and only "
		+ "they know whether a lock exists to release)");

	// And once the destination is back online the SAME export proceeds past the preflight — the
	// refusal is stateless. (This harness's import send throws by design, so the proof that the
	// preflight admitted the transfer is that the send was REACHED at all.)
	calls.offlineInstances.clear();
	await orch.transferPlatform("export_1", 2);
	assert.equal(calls.importSends, 1, "back online, the preflight admits the transfer to the import send");
	const transfer = onlyTransfer(activeTransfers);
	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);
});

test("a throw AFTER the destination accepted must NOT authorize an unlock", async () => {
	// THE duplication guard, adversarial (review blocker). transferPlatform has exactly one failure
	// return that follows a DELIVERED import: a throw between the destination's ACK and the success
	// return (here: persistPendingTransfer throwing inside enterAwaitingValidation). If that return
	// carried safeToUnlockSource, the instance-side caller would clear the lock the source-delete
	// gate requires — a later validation SUCCESS then finds "source is not locked-for-transfer",
	// refuses the delete, and a PERMANENT DUPLICATE exists. This test goes RED if anyone makes that
	// return "safe", or resurrects an unconditional unlock in the catch.
	const { orch, activeTransfers, calls } = makeHarness(() => ({ success: true }));
	const plugin = orch.plugin;
	plugin.persistPendingTransfer = () => { throw new Error("disk full persisting intent"); };

	const res = await orch.transferPlatform("export_1", 2);

	assert.equal(calls.importSends, 1, "the import was delivered and accepted");
	assert.equal(res.success, false, "the throw still fails the call");
	assert.notEqual(res.safeToUnlockSource, true,
		"a post-acceptance failure must NEVER authorize an unlock — the destination holds the copy");
	assert.equal(calls.unlockRouteTaken, 0,
		"and the orchestrator itself must not unlock either (the armed validation timeout resolves it)");
	const transfer = onlyTransfer(activeTransfers);
	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);
});

test("a failed transfer whose destination was deliberately PRESERVED is not replayable", async () => {
	// Review finding: "failed" is the replaceable settled state BECAUSE its rollback discarded the
	// destination. The one-shot debug preserve flag breaks that premise — the destination still
	// exists, paused — so a same-ID re-run would import a second copy beside it.
	const { orch, activeTransfers, calls } = makeHarness(() => { throw sessionLost("Session Closed"); });
	const res = await orch.transferPlatform("export_1", 2);
	const transfer = onlyTransfer(activeTransfers);
	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);
	orch.tryUnlockSource = async () => { calls.unlockRouteTaken++; return null; };

	await orch.handleTransferValidation({ transferId: res.transferId, success: false, validation: {
		mismatchDetails: "forced failure with preserve armed",
		destinationPreserved: true,
	} });
	assert.equal(transfer.status, "failed", "preservation is deliberate, not a leftover — status stays failed");

	const sendsBefore = calls.importSends;
	const retry = await orch.transferPlatform("export_1", 2);
	assert.equal(retry.success, false, "the replay must be refused");
	assert.match(String(retry.error), /PRESERVED/,
		"and the refusal must say WHY — the preserved copy is what a re-run would duplicate beside");
	assert.equal(calls.importSends, sendsBefore, "nothing may be sent on the refused replay");
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

// ── W1: the timeout-vs-late-verdict duplication window ──────────────────────────────────────────
//
// The window: the controller times out waiting for validation, fabricates a failed verdict, and
// rolls back (source unlocked, status settled as "failed"). The destination never heard about the
// timeout — it finishes importing on its own clock and sends a late GENUINE verdict. Pre-guard,
// handleTransferValidation had no status check, so a late SUCCESS re-entered the success handler
// and sent a source DELETE against a rolled-back (live, unlocked) source: the delete gate refuses,
// and live copies exist on BOTH instances. These tests drive the timeout DISPATCH directly (the
// timer callback body is exactly "dispatch a fabricated failed verdict"), so nothing here waits on
// a real timer.

test("W1 guard: a late genuine SUCCESS after a validation timeout must NOT drive a source delete", async () => {
	const { orch, activeTransfers, calls, plugin } = makeHarness(() => ({ success: true }));
	const res = await orch.transferPlatform("export_1", 2); // ACK path -> awaiting_validation
	const transfer = onlyTransfer(activeTransfers);
	assert.equal(transfer.status, "awaiting_validation");
	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout); // dispatch directly instead

	// Count source-delete sends from here on (the thing the guard must prevent).
	calls.deleteSends = 0;
	const origSendTo = plugin.controller.sendTo;
	plugin.controller.sendTo = async (dst, msg) => {
		if (msg && msg.constructor && msg.constructor.name === "DeleteSourcePlatformRequest") calls.deleteSends++;
		return origSendTo(dst, msg);
	};

	// The timeout path, invoked directly: the fabricated failed verdict (same shape the timer builds).
	await orch.handleTransferValidation({
		transferId: res.transferId, success: false,
		platformName: transfer.platformName, sourceInstanceId: transfer.sourceInstanceId,
		validation: { itemCountMatch: false, fluidCountMatch: false, mismatchDetails: "Validation timeout - no response received within 30s" },
	});
	assert.equal(transfer.status, "failed", "the timeout settles the transfer as failed (rollback ran)");
	assert.equal(calls.unlockRouteTaken, 1, "the rollback unlocked the source");

	// The destination finishes late and reports genuine SUCCESS.
	await orch.handleTransferValidation({
		transferId: res.transferId, success: true,
		platformName: transfer.platformName, sourceInstanceId: transfer.sourceInstanceId,
		validation: { itemCountMatch: true, fluidCountMatch: true },
	});

	assert.equal(calls.deleteSends, 0,
		"THE DEFECT: a late SUCCESS on a settled transfer must never send DeleteSourcePlatformRequest "
		+ "- the source was already unlocked and returned to the player");
	assert.equal(transfer.status, "failed", "the settled status must not change");
	assert.match(String(transfer.validationResult && transfer.validationResult.mismatchDetails),
		/timeout/i, "the settled record's verdict must not be overwritten by the late one");
	assert.ok(calls.events.includes("validation_after_settle"),
		"the refusal must be LOUD: a validation_after_settle event names the live-destination residual");
});

test("W1 guard: a late FAILURE after a completed transfer must not roll back", async () => {
	const { orch, activeTransfers, calls } = makeHarness(() => ({ success: true }));
	const res = await orch.transferPlatform("export_1", 2);
	const transfer = onlyTransfer(activeTransfers);
	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);

	// Genuine SUCCESS completes the transfer (harness delete send succeeds -> status completed).
	await orch.handleTransferValidation({
		transferId: res.transferId, success: true,
		platformName: transfer.platformName, sourceInstanceId: transfer.sourceInstanceId,
		validation: { itemCountMatch: true, fluidCountMatch: true },
	});
	assert.equal(transfer.status, "completed");
	const unlocksAfterCompletion = calls.unlockRouteTaken;

	// A late (duplicate/replayed) FAILURE verdict arrives.
	await orch.handleTransferValidation({
		transferId: res.transferId, success: false,
		platformName: transfer.platformName, sourceInstanceId: transfer.sourceInstanceId,
		validation: { itemCountMatch: false, fluidCountMatch: false, mismatchDetails: "late duplicate" },
	});

	assert.equal(transfer.status, "completed", "a completed transfer must stay completed");
	assert.equal(calls.unlockRouteTaken, unlocksAfterCompletion,
		"no rollback: unlocking a deleted source is at best a spurious error, and the record must not flip");
	assert.ok(calls.events.includes("validation_after_settle"), "the late verdict is loudly logged, not silently dropped");
});

test("validation timeout config: default 30s, floor 5s, junk-safe, read per-arm", async () => {
	const { orch, plugin, activeTransfers } = makeHarness(() => ({ success: true }));

	assert.equal(orch.getValidationTimeoutMs(), 30_000, "no config accessor (unit harness) -> declared default");

	plugin.controller.config = { get: (field) => {
		assert.equal(field, "surface_export.transfer_validation_timeout_seconds");
		return 45;
	} };
	assert.equal(orch.getValidationTimeoutMs(), 45_000, "configured value is used");

	plugin.controller.config = { get: () => 2 };
	assert.equal(orch.getValidationTimeoutMs(), 5_000, "floor 5s: a typo cannot make every transfer insta-timeout");

	plugin.controller.config = { get: () => "banana" };
	assert.equal(orch.getValidationTimeoutMs(), 30_000, "junk -> default");

	plugin.controller.config = { get: () => 0 };
	assert.equal(orch.getValidationTimeoutMs(), 30_000, "0 would disable the timeout entirely -> default");

	// Per-arm read: arming a transfer consults the CURRENT config (no restart, no cached value).
	let reads = 0;
	plugin.controller.config = { get: () => { reads++; return 45; } };
	await orch.transferPlatform("export_1", 2);
	const transfer = onlyTransfer(activeTransfers);
	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);
	assert.ok(reads >= 1, "scheduleValidationTimeout must read the live config at arm time");
});
