"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const distNode = path.join(__dirname, "..", "dist", "node");
const { TransferOrchestrator } = require(path.join(distNode, "lib", "transfer-orchestrator.js"));
const { isSessionLostError } = require(path.join(distNode, "helpers.js"));
const messages = require(path.join(distNode, "messages.js"));

function sessionLost(message = "Session Closed") {
	return Object.assign(new Error(message), { code: "SessionLost" });
}

function makeHarness(importSendResult, sourceSendResult = () => ({ success: true })) {
	const noop = () => {};
	const activeTransfers = new Map();
	const calls = { events: [], unlockRouteTaken: 0, importSends: 0, openPhases: new Set() };

	const plugin = {
		logger: { error: noop, warn: noop, info: noop },
		persistPendingTransfer: (intent) => { calls.pendingPersisted = intent; },
		removePendingTransfer: (id) => { calls.pendingRemoved = id; },
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
		recordTransferStarted: async () => { calls.startRows = (calls.startRows || 0) + 1; },
		txLogger: {
			logTransactionEvent: (_id, type) => { calls.events.push(type); },
			archiveRecycledTransferId() {},
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
				return sourceSendResult(msg);
			},
		},
	};

	const orch = new TransferOrchestrator(plugin, messages);
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
	assert.equal(isSessionLostError("SessionLost"), false);
});

test("SessionLost on import send: source NOT unlocked, transfer enters awaiting_validation (#80)", async () => {
	const { orch, activeTransfers, calls } = makeHarness(() => { throw sessionLost("Session Closed"); });

	const res = await orch.transferPlatform("export_1", 2);

	assert.equal(calls.importSends, 1, "the import send must have been attempted");
	assert.equal(calls.unlockRouteTaken, 0, "source must NOT be unlocked on an ambiguous SessionLost");

	const transfer = onlyTransfer(activeTransfers);
	assert.equal(transfer.status, "awaiting_validation", "must arm validation, not roll back");
	assert.ok(transfer.validationTimeout, "the validation timeout must be armed to resolve it later");
	assert.ok(calls.events.includes("import_delivery_uncertain"), "the uncertain-delivery route must be logged");
	assert.equal(calls.openPhases.has("transmission"), false, "transmission phase must be closed on the recovery path");
	assert.equal(calls.openPhases.has("validation"), true, "validation phase is open while awaiting validation");

	assert.equal(res.success, true, "the transfer continues through the state machine");
	assert.ok(res.transferId, "a transferId is returned so the caller can track it");

	clearTimeout(transfer.validationTimeout);
});

test("Non-session-loss throw on import send: source IS rolled back (unlock route runs)", async () => {
	const { orch, activeTransfers, calls } = makeHarness(() => { throw new Error("malformed request"); });

	const res = await orch.transferPlatform("export_1", 2);

	assert.equal(calls.importSends, 1, "the import send must have been attempted");
	assert.equal(calls.unlockRouteTaken, 1, "a definite non-delivery error must roll back (unlock) the source");

	const transfer = onlyTransfer(activeTransfers);
	assert.notEqual(transfer.status, "awaiting_validation", "a definite failure must not enter awaiting_validation");
	assert.equal(res.success, false);

	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);
});

test("#106: validation fails AND source unlock fails → status is plain 'failed', intent still KEPT", async () => {
	const { orch, activeTransfers, calls } = makeHarness(() => { throw sessionLost("Session Closed"); });
	const res = await orch.transferPlatform("export_1", 2);
	const transfer = onlyTransfer(activeTransfers);
	assert.equal(transfer.status, "awaiting_validation");
	assert.ok(calls.pendingPersisted, "the recovery intent was persisted on awaiting_validation");
	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);

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
	const { orch, activeTransfers, calls } = makeHarness(() => { throw sessionLost("Session Closed"); });
	const res = await orch.transferPlatform("export_1", 2);
	const transfer = onlyTransfer(activeTransfers);
	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);

	orch.tryUnlockSource = async () => { calls.unlockRouteTaken++; return null; };
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

	calls.offlineInstances.clear();
	await orch.transferPlatform("export_1", 2);
	assert.equal(calls.importSends, 1, "back online, the preflight admits the transfer to the import send");
	const transfer = onlyTransfer(activeTransfers);
	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);
});

test("a throw AFTER the destination accepted must NOT authorize an unlock", async () => {
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
	const { orch, activeTransfers, calls } = makeHarness(() => { throw sessionLost("Session Closed"); });
	const res = await orch.transferPlatform("export_1", 2);
	const transfer = onlyTransfer(activeTransfers);
	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);

	orch.tryUnlockSource = async () => { calls.unlockRouteTaken++; return null; };
	calls.pendingRemoved = undefined;

	await orch.handleTransferValidation({ transferId: res.transferId, success: false, validation: { mismatchDetails: "item mismatch" } });

	assert.equal(transfer.status, "failed", "failed validation + successful unlock is 'failed'");
	assert.equal(calls.pendingRemoved, res.transferId, "the recovery intent is dropped once the source is unlocked");
});


test("W1 guard: a late genuine SUCCESS after a validation timeout must NOT drive a source delete", async () => {
	const { orch, activeTransfers, calls, plugin } = makeHarness(() => ({ success: true }));
	const res = await orch.transferPlatform("export_1", 2);
	const transfer = onlyTransfer(activeTransfers);
	assert.equal(transfer.status, "awaiting_validation");
	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);

	calls.deleteSends = 0;
	const origSendTo = plugin.controller.sendTo;
	plugin.controller.sendTo = async (dst, msg) => {
		if (msg && msg.constructor && msg.constructor.name === "DeleteSourcePlatformRequest") calls.deleteSends++;
		return origSendTo(dst, msg);
	};

	await orch.handleTransferValidation({
		transferId: res.transferId, success: false,
		platformName: transfer.platformName, sourceInstanceId: transfer.sourceInstanceId,
		validation: { itemCountMatch: false, fluidCountMatch: false, mismatchDetails: "Validation timeout - no response received within 30s" },
	});
	assert.equal(transfer.status, "failed", "the timeout settles the transfer as failed (rollback ran)");
	assert.equal(calls.unlockRouteTaken, 1, "the rollback unlocked the source");

	await orch.handleTransferValidation({
		transferId: res.transferId, success: true,
		platformName: transfer.platformName, sourceInstanceId: transfer.sourceInstanceId,
		validation: { itemCountMatch: true, fluidCountMatch: true },
	});

	assert.equal(calls.deleteSends, 0,
		"a late SUCCESS on a settled transfer must never send DeleteSourcePlatformRequest "
		+ "- the source was already unlocked and returned to the player");
	assert.equal(transfer.status, "cleanup_failed",
		"REVIEW FINDING: the late-live destination is a platform left behind, so the record must wear "
		+ "cleanup_failed (its one meaning) - leaving it 'failed' (the one status retries may replace) "
		+ "turned the 'retry works' guidance into a second copy imported beside the orphan");
	assert.match(String(transfer.validationResult && transfer.validationResult.mismatchDetails),
		/timeout/i, "the settled record's verdict must not be overwritten by the late one");
	assert.ok(calls.events.includes("validation_after_settle"),
		"the refusal must be LOUD: a validation_after_settle event names the live-destination residual");

	const importSendsBefore = calls.importSends;
	const retry = await orch.transferPlatform("export_1", 2);
	assert.equal(retry.success, false, "retrying beside a live destination copy must be refused");
	assert.equal(calls.importSends, importSendsBefore, "no second import may be sent");
});

test("W1 guard: a late genuine FAILURE carrying destinationPreserved is ADOPTED (retry guard reads it)", async () => {
	const { orch, activeTransfers, calls } = makeHarness(() => ({ success: true }));
	const res = await orch.transferPlatform("export_1", 2);
	const transfer = onlyTransfer(activeTransfers);
	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);

	await orch.handleTransferValidation({
		transferId: res.transferId, success: false,
		platformName: transfer.platformName, sourceInstanceId: transfer.sourceInstanceId,
		validation: { itemCountMatch: false, fluidCountMatch: false, mismatchDetails: "Validation timeout - no response received within 30s" },
	});
	assert.equal(transfer.status, "failed");

	await orch.handleTransferValidation({
		transferId: res.transferId, success: false,
		platformName: transfer.platformName, sourceInstanceId: transfer.sourceInstanceId,
		validation: { itemCountMatch: false, fluidCountMatch: false, mismatchDetails: "item mismatch", destinationPreserved: true },
	});

	assert.equal(transfer.status, "failed", "a self-resolved destination leaves nothing behind - status stays failed");
	assert.equal(transfer.validationResult && transfer.validationResult.destinationPreserved, true,
		"the genuine verdict (the only destinationPreserved carrier) must be adopted onto the record");
	const importSendsBefore = calls.importSends;
	const retry = await orch.transferPlatform("export_1", 2);
	assert.equal(retry.success, false, "the preserved-destination retry guard must now see the flag and refuse");
	assert.equal(calls.importSends, importSendsBefore);
});

test("validation timeout ceiling: 120s cap protects the source-lock TTL budget (and setTimeout)", async () => {
	const { orch, plugin } = makeHarness(() => ({ success: true }));
	plugin.controller.config = { get: () => 900 };
	assert.equal(orch.getValidationTimeoutMs(), 120_000,
		"above the Lua validation budget the lock could TTL-expire mid-wait - clamp to 120s");
	plugin.controller.config = { get: () => 1e12 };
	assert.equal(orch.getValidationTimeoutMs(), 120_000,
		"a huge value must clamp, never overflow setTimeout into a 1ms insta-timeout");
	plugin.controller.config = { get: () => 120 };
	assert.equal(orch.getValidationTimeoutMs(), 120_000, "the ceiling itself is allowed");
});

test("per-arm read is PINNED: the armed delay on the record equals the configured value", async () => {
	const { orch, plugin, activeTransfers } = makeHarness(() => ({ success: true }));
	plugin.controller.config = { get: () => 45 };
	await orch.transferPlatform("export_1", 2);
	const transfer = onlyTransfer(activeTransfers);
	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);
	assert.equal(transfer.armedValidationTimeoutMs, 45_000,
		"the timer must be armed with the live config value, not a cached or default one");
});

test("a throwing config accessor cannot strand a transfer outside awaiting_validation", async () => {
	const { orch, activeTransfers, plugin } = makeHarness(() => ({ success: true }));
	plugin.controller.config = { get: () => { throw new Error("InvalidField: not registered"); } };
	const res = await orch.transferPlatform("export_1", 2);
	assert.equal(res.success, true, "the transfer must proceed on the default timeout");
	const transfer = onlyTransfer(activeTransfers);
	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);
	assert.equal(transfer.status, "awaiting_validation",
		"the record must reach awaiting_validation - anything else is terminal under the guard");
	assert.equal(transfer.armedValidationTimeoutMs, 30_000, "default armed when the accessor throws");
});

test("W1 guard: a late FAILURE after a completed transfer must not roll back", async () => {
	const { orch, activeTransfers, calls } = makeHarness(() => ({ success: true }));
	const res = await orch.transferPlatform("export_1", 2);
	const transfer = onlyTransfer(activeTransfers);
	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);

	await orch.handleTransferValidation({
		transferId: res.transferId, success: true,
		platformName: transfer.platformName, sourceInstanceId: transfer.sourceInstanceId,
		validation: { itemCountMatch: true, fluidCountMatch: true },
	});
	assert.equal(transfer.status, "completed");
	const unlocksAfterCompletion = calls.unlockRouteTaken;

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

	let reads = 0;
	plugin.controller.config = { get: () => { reads++; return 45; } };
	await orch.transferPlatform("export_1", 2);
	const transfer = onlyTransfer(activeTransfers);
	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);
	assert.ok(reads >= 1, "scheduleValidationTimeout must read the live config at arm time");
});

test("W1 guard: a late FAILURE reporting cleanup_failed marks the ACCIDENTAL orphan like the deliberate one", async () => {
	const { orch, activeTransfers, calls } = makeHarness(() => ({ success: true }));
	const res = await orch.transferPlatform("export_1", 2);
	const transfer = onlyTransfer(activeTransfers);
	if (transfer.validationTimeout) clearTimeout(transfer.validationTimeout);

	await orch.handleTransferValidation({
		transferId: res.transferId, success: false,
		platformName: transfer.platformName, sourceInstanceId: transfer.sourceInstanceId,
		validation: { itemCountMatch: false, fluidCountMatch: false, mismatchDetails: "Validation timeout - no response received within 30s" },
	});
	assert.equal(transfer.status, "failed");

	await orch.handleTransferValidation({
		transferId: res.transferId, success: false,
		platformName: transfer.platformName, sourceInstanceId: transfer.sourceInstanceId,
		validation: { itemCountMatch: false, fluidCountMatch: false, mismatchDetails: "item mismatch",
			cleanup_failed: true, cleanup_error: "GameUtils.delete_platform failed: returned false" },
	});

	assert.equal(transfer.status, "cleanup_failed",
		"an engine-refused discard leaves an orphan - the accidental orphan must refuse retries "
		+ "exactly like the deliberate destinationPreserved one");
	assert.match(String(transfer.error), /orphan copy remains/);
	const importSendsBefore = calls.importSends;
	const retry = await orch.transferPlatform("export_1", 2);
	assert.equal(retry.success, false, "retrying beside the orphan must be refused");
	assert.equal(calls.importSends, importSendsBefore, "no second import may be sent");
});

test("timeout config warnings: junk SET values warn, in-range fractionals do not", async () => {
	const { orch, plugin } = makeHarness(() => ({ success: true }));
	const warns = [];
	plugin.logger.warn = (msg) => { warns.push(String(msg)); };

	plugin.controller.config = { get: () => 30.5 };
	assert.equal(orch.getValidationTimeoutMs(), 30_000);
	assert.equal(warns.length, 0, "an in-range fractional is not a misconfiguration - no false warn");

	plugin.controller.config = { get: () => "banana" };
	assert.equal(orch.getValidationTimeoutMs(), 30_000);
	assert.equal(warns.length, 1, "a SET junk value must be visible, not silently corrected");
	assert.match(warns[0], /not a positive number/);

	plugin.controller.config = { get: () => 900 };
	assert.equal(orch.getValidationTimeoutMs(), 120_000);
	assert.equal(warns.length, 2, "an out-of-range value warns");
	assert.match(warns[1], /outside/);

	plugin.controller.config = { get: () => undefined };
	assert.equal(orch.getValidationTimeoutMs(), 30_000);
	assert.equal(warns.length, 2, "UNSET is the normal default case - silent");

	plugin.controller.config = { get: () => null };
	assert.equal(orch.getValidationTimeoutMs(), 30_000);
	assert.equal(warns.length, 2, "a CLEARED optional field (null) is not a misconfiguration - silent");
});
