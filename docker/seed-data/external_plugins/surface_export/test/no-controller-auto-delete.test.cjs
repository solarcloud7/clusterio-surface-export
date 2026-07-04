"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const pluginDir = path.join(__dirname, "..");
const distNode = path.join(pluginDir, "dist", "node");
const { ControllerPlugin, PENDING_TRANSFER_INTENT_RETENTION_MS } = require(path.join(distNode, "controller.js"));

function read(rel) {
	return fs.readFileSync(path.join(pluginDir, rel), "utf8");
}

function makeControllerHarness(pendingEntries = []) {
	const calls = { sends: [], persisted: 0, infos: [], warns: [], errors: [] };
	const plugin = Object.create(ControllerPlugin.prototype);
	plugin.pendingTransfers = new Map(pendingEntries.map((entry) => [entry.transferId, entry]));
	plugin.platformStorage = new Map();
	plugin.logger = {
		info: (msg) => calls.infos.push(msg),
		warn: (msg) => calls.warns.push(msg),
		error: (msg) => calls.errors.push(msg),
		verbose: () => {},
	};
	plugin.subscriptions = { treeBroadcastLimiter: { cancel: () => {} } };
	plugin.controller = {
		sendTo: async (...args) => { calls.sends.push(args); },
	};
	plugin.persistPendingTransfers = async () => { calls.persisted++; };
	return { plugin, calls };
}

function pendingIntent(overrides = {}) {
	return {
		transferId: "transfer-1",
		sourceInstanceId: 1,
		sourcePlatformIndex: 3,
		sourcePlatformName: "test-platform",
		forceName: "player",
		targetInstanceId: 2,
		startedAt: Date.now(),
		exportId: "export-1",
		...overrides,
	};
}

test("controller restart path does not auto-delete sources from persisted intents", async () => {
	const { plugin, calls } = makeControllerHarness([pendingIntent()]);

	// R3 teeth: the retired #60 spine was a setInterval poll loop whose delete/unlock sends fire as a LATER
	// macrotask — after a synchronous sends===0 assert. Spy the schedulers around onStart so a timer-scheduled
	// reintroduction is caught, then drain a macrotask to catch a setTimeout(…, 0) variant too.
	const origSetInterval = global.setInterval;
	const origSetTimeout = global.setTimeout;
	const timers = [];
	global.setInterval = (...a) => { timers.push(["interval", a]); return { unref() {} }; };
	global.setTimeout = (...a) => { timers.push(["timeout", a]); return { unref() {} }; };
	try {
		await plugin.onStart();
	} finally {
		global.setInterval = origSetInterval;
		global.setTimeout = origSetTimeout;
	}

	assert.equal(timers.length, 0, "onStart must not SCHEDULE a timer (the retired reconcile was a setInterval poll)");
	assert.equal(calls.sends.length, 0, "onStart must not send delete/unlock/reconcile requests for boot-leftover intents");
	await new Promise((r) => origSetTimeout(r, 0)); // drain one macrotask round
	assert.equal(calls.sends.length, 0, "no delete/unlock send may fire on a later macrotask either");
	assert.match(calls.warns.join("\n"), /source-side TTL unlock/, "restart warning should point at source-side TTL recovery");
});

test("pending transfer observability store prunes stale entries", async () => {
	const now = Date.now();
	const { plugin, calls } = makeControllerHarness([
		pendingIntent({ transferId: "fresh", startedAt: now - 1_000 }),
		pendingIntent({ transferId: "stale", startedAt: now - PENDING_TRANSFER_INTENT_RETENTION_MS - 1 }),
		pendingIntent({ transferId: "invalid", startedAt: "not-a-number" }),
	]);

	const pruned = await plugin.prunePendingTransfers(now);

	assert.equal(pruned, 2, "stale/invalid persisted intents should be pruned");
	assert.deepEqual([...plugin.pendingTransfers.keys()], ["fresh"]);
	assert.equal(calls.persisted, 1, "pruning should persist the compacted observability store");
});

test("controller source-outcome failsafe code is retired", () => {
	const controller = read("controller.ts");
	const orchestrator = read(path.join("lib", "transfer-orchestrator.ts"));
	const remoteInterface = read(path.join("module", "interfaces", "remote-interface.lua"));
	const importCompletion = read(path.join("module", "core", "import-completion.lua"));

	assert.doesNotMatch(controller, /GetTransferOutcomeRequest/, "controller boot/reconcile must not query destination outcome as a failsafe");
	assert.doesNotMatch(controller, /resolveStrandedTransfer\s*\([^)]*["']complete["']/, "controller must not complete/delete a stranded source on boot");
	assert.doesNotMatch(controller, /reconcilePendingTransfers/, "controller boot reconcile loop should be retired in Phase 1");
	assert.doesNotMatch(orchestrator, /kind:\s*["']complete["']|kind\s*===\s*["']complete["']/, "orchestrator must not expose a restart-complete auto-delete branch");
	assert.doesNotMatch(remoteInterface, /get_transfer_outcome/, "destination outcome query remote should not be registered as a failsafe");
	assert.doesNotMatch(importCompletion, /surface_export_transfer_outcomes/, "destination must not persist transfer success before finalization");
});
