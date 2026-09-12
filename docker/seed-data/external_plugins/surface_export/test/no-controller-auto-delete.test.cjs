"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const pluginDir = path.join(__dirname, "..");
const distNode = path.join(pluginDir, "dist", "node");
const { ControllerPlugin, SOURCE_COMMIT_MARKER_RETENTION_MS } = require(path.join(distNode, "controller.js"));

function read(rel) {
	return fs.readFileSync(path.join(pluginDir, rel), "utf8");
}

function makeControllerHarness(pendingEntries = []) {
	const calls = { sends: [], persisted: 0, infos: [], warns: [], errors: [] };
	const plugin = Object.create(ControllerPlugin.prototype);
	plugin.pendingTransfers = new Map(pendingEntries.map((entry) => [entry.transferId, entry]));
	plugin.sourceCommitMarkers = new Map();
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
	plugin.persistSourceCommitMarkers = async () => { calls.persisted++; };
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

test("controller restart schedules the guarded recovery path without directly deleting or unlocking", async () => {
	const { plugin, calls } = makeControllerHarness([pendingIntent()]);
	let recoveries = 0, observations = 0;
	plugin.orchestrator = { recoverPendingTransfers: async () => { recoveries++; }, observeJobs: async () => { observations++; } };

	const origSetInterval = global.setInterval;
	const origSetTimeout = global.setTimeout;
	const timers = [];
	global.setInterval = (...a) => { timers.push(["interval", a]); return { unref() {} }; };
	global.setTimeout = (...a) => { timers.push(["timeout", a]); return { unref() {} }; };
	try {
		plugin.startRecovery();
	} finally {
		global.setInterval = origSetInterval;
		global.setTimeout = origSetTimeout;
	}

	assert.equal(timers.length, 1);
	assert.match(ControllerPlugin.prototype.init.toString(), /this\.startRecovery\(\)/,
		"recovery must be wired into Clusterio's init hook, not an invented onStart hook");
	assert.equal(timers[0][0], "interval");
	assert.equal(timers[0][1][1], 5_000);
	assert.equal(calls.sends.length, 0, "onStart must not send delete/unlock/reconcile requests for boot-leftover intents");
	timers[0][1][0]();
	await new Promise((r) => origSetTimeout(r, 0));
	assert.equal(recoveries, 1);
	timers[0][1][0]();
	await new Promise((r) => origSetTimeout(r, 0));
	assert.equal(recoveries, 1, "status visits must not accelerate ownership recovery");
	assert.equal(observations, 1, "status must not wait for another recovery interval");
	assert.equal(calls.sends.length, 0, "no delete/unlock send may fire on a later macrotask either");
	assert.match(calls.warns.join("\n"), /validated destination hold/);
});

test("required recovery persistence refuses a missing intent before writing an empty store", async () => {
	const { plugin } = makeControllerHarness();
	await assert.rejects(ControllerPlugin.prototype.persistPendingTransfers.call(plugin, "1:expired"),
		/Recovery intent unavailable for 1:expired/);
});

test("new transfers and recovery ticks retain unresolved intents across clock jumps", async () => {
	const now = Date.now();
	const { plugin, calls } = makeControllerHarness([
		pendingIntent({ transferId: "fresh", startedAt: now - 1_000 }),
		pendingIntent({ transferId: "old", startedAt: now - 24 * 60 * 60 * 1000 }),
	]);

	const old = plugin.pendingTransfers.get("old");
	plugin.persistPendingTransfer(pendingIntent({transferId: "new"}));
	assert.equal(plugin.pendingTransfers.get("old"), old, "new work must not erase unresolved recovery");
	const originalInterval = global.setInterval, originalNow = Date.now;
	let callback, observed;
	plugin.orchestrator = { recoverPendingTransfers: async () => { observed = plugin.pendingTransfers.get("old"); } };
	global.setInterval = fn => { callback = fn; return { unref() {} }; };
	try {
		plugin.startRecovery();
		Date.now = () => now + 365 * 24 * 60 * 60 * 1000;
		callback();
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(observed, old, "elapsed wall time does not invalidate recovery authority");
	} finally { global.setInterval = originalInterval; Date.now = originalNow; }
	plugin.removePendingTransfer("old");
	assert.equal(plugin.pendingTransfers.has("old"), false, "explicit resolution still removes the intent");
	assert.equal(calls.persisted, 2);
});

test("COMMIT-transmitted markers persist write-ahead but are bounded and non-authoritative", async () => {
	const now = Date.now();
	const { plugin, calls } = makeControllerHarness();

	plugin.recordCommitTransmitted({
		transferId: "source-1:export-1",
		sourceInstanceId: 1,
		sourcePlatformIndex: 3,
		sourcePlatformName: "test-platform",
		forceName: "player",
		committedAt: now,
	});

	assert.equal(plugin.sourceCommitMarkers.get("source-1:export-1").committedAt, now, "COMMIT marker should be persisted before transmit");
	assert.equal(calls.persisted, 1, "recording a COMMIT marker must persist it immediately");

	plugin.sourceCommitMarkers.set("fresh", { transferId: "fresh", committedAt: now - 1_000 });
	plugin.sourceCommitMarkers.set("stale", { transferId: "stale", committedAt: now - SOURCE_COMMIT_MARKER_RETENTION_MS - 1 });
	plugin.sourceCommitMarkers.set("invalid", { transferId: "invalid", committedAt: "not-a-number" });
	const pruned = await plugin.pruneSourceCommitMarkers(now);

	assert.equal(pruned, 2, "stale/invalid COMMIT markers should be pruned");
	assert.deepEqual([...plugin.sourceCommitMarkers.keys()].sort(), ["fresh", "source-1:export-1"].sort());
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
