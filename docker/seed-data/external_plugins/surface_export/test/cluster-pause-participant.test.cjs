"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const distNode = path.join(__dirname, "..", "dist", "node");
const { ClusterPauseParticipant, CLUSTER_PAUSE_RENDEZVOUS, joinClusterPause } = require(path.join(distNode, "lib", "cluster-pause-participant.js"));
const { TransferOrchestrator } = require(path.join(distNode, "lib", "transfer-orchestrator.js"));
const { ControllerPlugin } = require(path.join(distNode, "controller.js"));
const { timingContext } = require(path.join(distNode, "lib", "timing.js"));
const messages = require(path.join(distNode, "messages.js"));
const { LineageRegistry, withLineage, presenceOf } = require("./lineage-harness.cjs");

const PAUSING = /The cluster is pausing because no players are online/;
const quiet = { info() {}, warn() {}, error() {} };

function source(overrides = {}) {
	return { activeTransfers: new Map(), pendingTransfers: new Map(), recoveryReservations: new Map(), ...overrides };
}

function fakeApi() {
	const api = { registered: new Map(), changed: 0,
		registerParticipant(name, handlers) { this.registered.set(name, handlers); },
		holdsChanged() { this.changed++; } };
	return api;
}

function joined(state = source()) {
	const host = {};
	const api = fakeApi();
	host[CLUSTER_PAUSE_RENDEZVOUS] = { api, waiting: [] };
	const participant = new ClusterPauseParticipant(state, quiet);
	participant.attach(host);
	return { participant, api, handlers: api.registered.get("surface_export") };
}

test("without cluster_pause the participant never registers, refuses nothing and runs admissions unchanged", async () => {
	const host = {};
	const participant = new ClusterPauseParticipant(source(), quiet);
	participant.attach(host);
	assert.equal(participant.joined, false);
	assert.equal(host[CLUSTER_PAUSE_RENDEZVOUS].waiting.length, 1);
	participant.onPhase({ phase: "paused", paused: [1] });
	assert.equal(participant.refusal([1, 2]), null);
	assert.equal(await participant.track(async () => "admitted"), "admitted");
	const plugin = Object.create(ControllerPlugin.prototype);
	assert.equal(plugin.clusterPauseRefusal([1]), null);
	assert.equal(await plugin.trackAdmission(async () => "same"), "same");
	assert.doesNotThrow(() => plugin.clusterPauseHoldsChanged());
});

test("a participant waiting for cluster_pause registers when the plugin publishes its API later", () => {
	const host = {};
	const participant = new ClusterPauseParticipant(source(), quiet);
	participant.attach(host);
	const api = fakeApi();
	const rendezvous = host[CLUSTER_PAUSE_RENDEZVOUS];
	rendezvous.api = api;
	for (const ready of rendezvous.waiting.splice(0)) ready(api);
	assert.equal(participant.joined, true);
	assert.ok(api.registered.has("surface_export"));
	let late = null;
	joinClusterPause(host, value => { late = value; });
	assert.equal(late, api);
});

test("holds cover active and queued work, pending intents, passengers, admissions, recovery, resolutions and unreadable state", async () => {
	const state = source({
		activeTransfers: new Map([
			["q", { transferId: "q", operationType: "transfer", status: "queued" }],
			["a", { transferId: "a", operationType: "transfer", status: "awaiting_validation", passengers: [{ name: "Solar" }, { name: "" }] }],
			["c", { transferId: "c", operationType: "transfer", status: "cleanup_failed" }],
			["i", { transferId: "i", operationType: "import", status: "awaiting_completion" }],
			["done", { transferId: "done", operationType: "transfer", status: "completed" }],
			["late", { transferId: "late", operationType: "transfer", status: "failed", timingPendingRecovery: true }],
		]),
		pendingTransfers: new Map([["a", {}], ["orphan", {}]]),
		recoveryReservations: new Map([[7, {}]]),
		lineageRegistry: { listResolutions: () => [{ requestId: "r1", status: "in_progress" }, { requestId: "r0", status: "completed" }] },
		pendingTransfersLoadError: "pending journal unreadable",
	});
	const { participant, handlers, api } = joined(state);
	let inside;
	await participant.track(async () => { inside = handlers.listHolds(); });
	assert.ok(api.changed >= 2);
	assert.deepEqual(inside.find(hold => hold.reason === "admission request in progress"), { reason: "admission request in progress", ref: "1" });
	assert.deepEqual(handlers.listHolds(), [
		{ reason: "transfer queued", ref: "q" },
		{ reason: "transfer awaiting_validation", ref: "a" },
		{ reason: "passenger in transit", ref: "Solar" },
		{ reason: "transfer cleanup_failed", ref: "c" },
		{ reason: "import awaiting_completion", ref: "i" },
		{ reason: "transfer failed", ref: "late" },
		{ reason: "pending transfer intent", ref: "orphan" },
		{ reason: "instance reconciling its save", ref: "7" },
		{ reason: "platform resolution in progress", ref: "r1" },
		{ reason: "transfer state unavailable", ref: "pending journal unreadable" },
	]);
	assert.deepEqual(joined().handlers.listHolds(), []);
});

test("an instance with Surface Export holds the pause from starting until its recovery finishes", () => {
	const state = source();
	const { participant, handlers, api } = joined(state);
	participant.onInstanceStatus(4, "starting", false);
	participant.onInstanceStatus(5, "starting", true);
	assert.deepEqual(handlers.listHolds(), [{ reason: "instance starting up", ref: "5" }]);
	participant.onInstanceStatus(5, "running", true);
	state.recoveryReservations.set(5, {});
	assert.deepEqual(handlers.listHolds(), [{ reason: "instance reconciling its save", ref: "5" }]);
	state.recoveryReservations.delete(5);
	const before = api.changed;
	participant.onRecoveryFinished(5);
	assert.equal(api.changed, before + 1);
	assert.deepEqual(handlers.listHolds(), []);
	participant.onInstanceStatus(6, "starting", true);
	participant.onInstanceStatus(6, "stopped", true);
	assert.deepEqual(handlers.listHolds(), []);
});

test("new work is refused while draining or paused, and to an instance whose resume is unconfirmed", () => {
	const { participant, handlers } = joined();
	assert.equal(participant.refusal([1]), null);
	for (const phase of ["running", "countdown"]) {
		handlers.onPhase({ phase, paused: [] });
		assert.equal(participant.refusal([1, 2]), null, phase);
	}
	handlers.onPhase({ phase: "draining", paused: [] });
	assert.match(participant.refusal([1]), PAUSING);
	handlers.onPhase({ phase: "paused", paused: [1, 2] });
	assert.match(participant.refusal([3]), /The cluster is paused/);
	handlers.onPhase({ phase: "running", paused: [2] });
	assert.equal(participant.refusal([1]), null);
	assert.match(participant.refusal([1, 2]), /Instance 2 has not confirmed it resumed/);
});

function orchestratorHarness(refusal) {
	const noop = () => {};
	const sent = [];
	const plugin = {
		logger: quiet, persistPendingTransfer: noop, removePendingTransfer: noop,
		isInstanceOnline: () => true, autoPauseRefusal: async () => null, clusterPauseRefusal: () => refusal,
		persistStorage: async () => {}, lineageRegistry: new LineageRegistry(), lineagePresence: presenceOf(),
		platformStorage: { get: id => ({ exportId: id, exportData: withLineage({ platform: { force: "player" } }), platformName: "fixture",
			platformIndex: 5, instanceId: 11, size: 10 }), delete: noop },
		platformTree: { resolveInstanceName: id => `instance-${id}`, resolvePlatformUid: async (_id, index, _force, uid) => uid || `fixture:${index}` },
		activeTransfers: new Map(), transactionLogs: new Map(), persistedTransactionLogs: [], pendingTransfers: new Map(),
		recordTransferStarted: async () => {},
		txLogger: { ...require("./timing-harness.cjs").makeTimingHarness(), logTransactionEvent: noop, archiveRecycledTransferId() {},
			startPhase: noop, endPhase: () => 0, persistTransactionLog: async () => {}, buildPhaseSummary: () => ({}), rejectObservation: async () => {} },
		subscriptions: { emitTransferUpdate: noop, queueTreeBroadcast: noop },
		controller: {
			instances: new Map([11, 22].map(id => [id, { id, isDeleted: false }])),
			sendTo: async (_target, message) => { sent.push(message.constructor.name); throw new Error("stop at dispatch"); },
		},
	};
	const orchestrator = new TransferOrchestrator(plugin, messages);
	return { orchestrator, plugin, sent };
}

test("a new gateway transfer is refused while pausing and the source may unlock; nothing is dispatched", async t => {
	const { orchestrator, plugin, sent } = orchestratorHarness("The cluster is pausing because no players are online, so new transfers, imports and exports are refused.");
	t.after(() => orchestrator.requestQueue.stop());
	const result = await orchestrator.transferPlatform("11:gateway-job", 22);
	assert.equal(result.success, false);
	assert.equal(result.safeToUnlockSource, true);
	assert.match(result.error, PAUSING);
	assert.match(result.error, /The source platform is unchanged/);
	assert.equal(plugin.activeTransfers.size, 0);
	assert.deepEqual(sent, []);
});

test("a replayed request for an active transfer is answered as active, never as a refusal that unlocks the source", async t => {
	const { orchestrator, plugin } = orchestratorHarness("The cluster is pausing because no players are online.");
	t.after(() => orchestrator.requestQueue.stop());
	plugin.activeTransfers.set("11:active-job", { transferId: "11:active-job", status: "awaiting_validation", targetInstanceId: 22 });
	const result = await orchestrator.transferPlatform("11:active-job", 22);
	assert.equal(result.success, true);
	assert.match(result.message, /already active/);
});

test("a transfer admitted through the queue before draining continues to dispatch", async t => {
	const { orchestrator, plugin, sent } = orchestratorHarness("The cluster is pausing because no players are online.");
	t.after(() => orchestrator.requestQueue.stop());
	const canonical = "11:queued-job", queuedId = "request:queued";
	const operation = { transferId: queuedId, startedAt: 1, status: "preparing", sourceInstanceId: 11, sourceExportId: "queued-job" };
	plugin.activeTransfers.set(queuedId, operation);
	orchestrator.requestQueue.entries.set(queuedId, { id: queuedId, operation, request: { sourceInstanceId: 11, sourcePlatformIndex: 5, targetInstanceId: 22 } });
	orchestrator.txLogger.bindObservation(queuedId, canonical);
	const result = await timingContext.run(orchestrator.txLogger.clock(canonical), () => orchestrator.transferPlatform(canonical, 22));
	assert.doesNotMatch(String(result.error ?? ""), PAUSING);
	assert.deepEqual(sent, ["ImportPlatformRequest"]);
	assert.ok(plugin.activeTransfers.has(canonical));
});

test("a new queued transfer request is refused while pausing, but a replay of a queued one is not", async t => {
	const { orchestrator } = orchestratorHarness("The cluster is pausing because no players are online.");
	t.after(() => orchestrator.requestQueue.stop());
	const request = { sourceInstanceId: 11, sourcePlatformIndex: 5, targetInstanceId: 22 };
	const refused = await orchestrator.handleStartPlatformTransferRequest(request);
	assert.equal(refused.success, false);
	assert.match(refused.error, PAUSING);
	assert.match(refused.error, /Nothing was locked or exported/);
	assert.equal(orchestrator.requestQueue.entries.size, 0);
	const operation = { transferId: "request:existing", status: "queued" };
	orchestrator.requestQueue.entries.set("request:existing", { id: "request:existing", operation, request: { ...request } });
	const replay = await orchestrator.handleStartPlatformTransferRequest(request);
	assert.equal(replay.success, true);
	assert.equal(replay.transferId, "request:existing");
});

test("a settled queue entry, or one pruned while admission awaited, does not let a new request past the pause", async t => {
	const { orchestrator, plugin } = orchestratorHarness("The cluster is pausing because no players are online.");
	t.after(() => orchestrator.requestQueue.stop());
	const request = { sourceInstanceId: 11, sourcePlatformIndex: 5, targetInstanceId: 22 };
	orchestrator.requestQueue.entries.set("request:done", { id: "request:done", operation: { transferId: "request:done", status: "completed" }, request: { ...request } });
	const settled = await orchestrator.handleStartPlatformTransferRequest(request);
	assert.equal(settled.success, false);
	assert.match(settled.error, PAUSING);
	orchestrator.requestQueue.entries.clear();
	orchestrator.requestQueue.entries.set("request:live", { id: "request:live", operation: { transferId: "request:live", status: "preparing" }, request: { ...request } });
	plugin.autoPauseRefusal = async () => { orchestrator.requestQueue.entries.clear(); return null; };
	const pruned = await orchestrator.handleStartPlatformTransferRequest(request);
	assert.equal(pruned.success, false);
	assert.match(pruned.error, PAUSING);
	assert.equal(orchestrator.requestQueue.entries.size, 0);
});

test("a new lineage resolution is refused while paused, and a retry of a known request goes through", async () => {
	const plugin = Object.create(ControllerPlugin.prototype);
	const resolved = [];
	plugin.resolver = { resolve: async request => { resolved.push(request.requestId); return { success: true, requestId: request.requestId }; } };
	plugin.lineageRegistry = { listResolutions: () => [{ requestId: "known-request", status: "in_progress" }] };
	plugin.logger = quiet;
	const { participant, handlers } = joined(source({ lineageRegistry: plugin.lineageRegistry }));
	plugin.clusterPause = participant;
	handlers.onPhase({ phase: "paused", paused: [] });
	const refused = await plugin.handleResolvePlatformLineageRequest({ instanceId: 3, requestId: "new-request" });
	assert.equal(refused.success, false);
	assert.match(refused.error, /The cluster is paused/);
	assert.match(refused.error, /Nothing was resolved/);
	assert.deepEqual(resolved, []);
	assert.equal((await plugin.handleResolvePlatformLineageRequest({ instanceId: 3, requestId: "known-request" })).success, true);
	assert.deepEqual(resolved, ["known-request"]);
});
