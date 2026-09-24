const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { TransferRequestQueue } = require("../dist/node/lib/transfer-request-queue");
const { TransferOrchestrator } = require("../dist/node/lib/transfer-orchestrator");
const { shipPhaseFor, groupEdgeShips } = require("../dist/node/shared/transfer-status");
const messages = require("../dist/node/messages");
const flush = () => new Promise(resolve => setImmediate(resolve));

test("unreadable or interrupted queue recovery disables admission without erasing evidence", async t => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "se-queue-invalid-"));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	for (const content of ["{broken", JSON.stringify([entry("1")])]) {
		const file = path.join(dir, "queue.json");
		await fs.writeFile(file, content);
		const errors = [];
		const queue = new TransferRequestQueue({ run: async () => assert.fail("unsafe admission"),
			interrupted: async () => { throw new Error("audit persistence unavailable"); },
			busyInstances: () => [], error: error => errors.push(error) });
		t.after(() => queue.stop());
		await queue.init(file);
		assert.equal(errors.length, 1);
		await assert.rejects(queue.add(entry("2")), /repair its journal/);
		await assert.rejects(queue.persist(), /repair its journal/);
		await queue.pump();
		assert.equal(await fs.readFile(file, "utf8"), content);
	}
});
function entry(id, source = 1, target = 2) {
	return { id, request: { sourceInstanceId: source, targetInstanceId: target, sourcePlatformIndex: Number(id) },
		operation: { transferId: id, status: "queued", sourceInstanceId: source, targetInstanceId: target } };
}

test("handoff claims survive queue removal, migration, restart and failed persistence", async t => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "se-handoff-"));
	t.after(() => fs.rm(dir, {recursive: true, force: true}));
	const file = path.join(dir, "queue.json");
	const create = () => {
		const queue = new TransferRequestQueue({run: async () => {}, interrupted: async () => {}, busyInstances: () => [], error: () => {}});
		t.after(() => queue.stop()); return queue;
	};
	await fs.writeFile(file, "[]");
	const first = create(); await first.init(file, ["1:legacy-snapshot"]);
	assert.equal(first.handoffs.get("1:legacy-snapshot").destination, null);
	await first.claimHandoff("1:captured", 2);
	await assert.rejects(first.claimHandoff("1:captured", 3), /already belongs/);
	first.entries.clear(); await first.persist(); first.stop();
	const second = create(); await second.init(file);
	await assert.rejects(second.claimHandoff("1:captured", 3), /already belongs/);
	await assert.rejects(second.claimHandoff("1:legacy-snapshot", 2), /already belongs/);
	assert.equal(second.handoffs.size, 2);
	second.persist = async () => {throw Error("disk refused");};
	await assert.rejects(second.claimHandoff("1:unsent", 2), /could not be persisted/);
	assert.ok(second.handoffs.has("1:unsent"));
	await assert.rejects(second.claimHandoff("1:another", 2), /could not be persisted/);
});

test("malformed handoff metadata is preserved and blocks admission", async t => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "se-handoff-invalid-"));
	t.after(() => fs.rm(dir, {recursive: true, force: true}));
	const file = path.join(dir, "queue.json");
	for (const handoffs of [[ ["1:a", {destination: -1}] ], [["bad", {destination: 2}]],
		[["1:a", {destination: 2}], ["1:a", {destination: 3}]], [["1:a", {destination: 2, cancelledBy: 4}]]]) {
		const raw = JSON.stringify({v: 2, entries: [], handoffs}); await fs.writeFile(file, raw);
		const queue = new TransferRequestQueue({run: async () => {}, interrupted: async () => {}, busyInstances: () => [], error: () => {}});
		t.after(() => queue.stop()); await queue.init(file);
		await assert.rejects(queue.claimHandoff("1:fresh", 2), /repair its journal/);
		assert.equal(await fs.readFile(file, "utf8"), raw);
	}
});

test("bounded overlapping transfers retain ownership and stop admission during recovery", async t => {
	const started = [];
	const plugin = { controller: { config: { get: () => 2 } }, activeTransfers: new Map(), pendingTransfers: new Map() };
	const orchestrator = new TransferOrchestrator(plugin, messages);
	t.after(() => orchestrator.requestQueue.stop());
	orchestrator.runQueuedRequest = async item => { started.push(item.id); item.operation.status = "awaiting_validation"; };
	const first = entry("1"), second = entry("2", 2, 1), third = entry("3");
	for (const item of [first, second, third]) {
		plugin.activeTransfers.set(item.id, item.operation);
		await orchestrator.requestQueue.add(item);
	}
	await orchestrator.requestQueue.pump(); await flush();
	assert.deepEqual(started, ["1", "2"], "combined capacity must include both directions");
	plugin.pendingTransfers.set(first.id, { sourceInstanceId: 1, targetInstanceId: 2 });
	first.operation.status = "failed"; first.operation.timingPendingRecovery = true;
	await orchestrator.requestQueue.pump(); assert.deepEqual(started, ["1", "2"]);
	first.operation.timingPendingRecovery = false;
	await orchestrator.requestQueue.pump(); assert.deepEqual(started, ["1", "2"], "unresolved retained intent must block admission");
	plugin.pendingTransfers.delete(first.id);
	await orchestrator.requestQueue.pump(); await flush(); assert.deepEqual(started, ["1", "2", "3"]);
});

test("pipeline capacity never bypasses an orphan recovery or an invalid limit", async t => {
	for (const capacity of [2, 4, 0, 5, NaN, 1.5]) {
		const started = [];
		const queue = new TransferRequestQueue({ capacity: () => capacity, busyInstances: () => [1],
			run: async item => started.push(item.id), interrupted: async () => {}, error: error => { throw error; } });
		t.after(() => queue.stop());
		await queue.add(entry("1")); await queue.add(entry("2", 3, 4)); await queue.add(entry("3", 4, 3));
		await queue.pump(); await flush();
		assert.deepEqual(started, capacity === 2 || capacity === 4 ? ["2", "3"] : ["2"]);
	}
});

test("orphan recovery authority reserves both instances even without an active timing record", async t => {
	const plugin = { activeTransfers: new Map(), pendingTransfers: new Map([["1:old", {
		sourceInstanceId: 1, targetInstanceId: 2,
	}]]) };
	const orchestrator = new TransferOrchestrator(plugin, messages);
	t.after(() => orchestrator.requestQueue.stop());
	const started = [];
	orchestrator.runQueuedRequest = async item => { started.push(item.id); };
	await orchestrator.requestQueue.add(entry("1"));
	await orchestrator.requestQueue.add(entry("2", 3, 4));
	await orchestrator.requestQueue.pump(); await flush();
	assert.deepEqual(started, ["2"], "retained authority must block only the affected instances");
	plugin.pendingTransfers.clear(); // Models acknowledged recovery, not age-based expiry.
	await orchestrator.requestQueue.pump(); await flush();
	assert.deepEqual(started, ["2", "1"]);
});
test("three requests sharing instances serialize through terminal recovery; unrelated routes can run", async t => {
	const started = [], errors = [];
	const queue = new TransferRequestQueue({ run: async item => { started.push(item.id); item.operation.status = "awaiting_validation"; },
		interrupted: async () => {}, busyInstances: () => [], error: error => errors.push(error) });
	t.after(() => queue.stop());
	const first = entry("1"), second = entry("2"), reverse = entry("3", 2, 1), independent = entry("4", 3, 4);
	for (const item of [first, second, reverse, independent]) await queue.add(item);
	await queue.pump(); await flush();
	assert.deepEqual(started, ["1", "4"]);
	first.operation.status = "failed"; first.operation.timingPendingRecovery = true;
	await queue.pump(); assert.deepEqual(started, ["1", "4"], "A failed verdict alone must not release admission");
	first.operation.timingPendingRecovery = false;
	await queue.pump(); await flush(); assert.deepEqual(started, ["1", "4", "2"]);
	second.operation.status = "completed";
	await queue.pump(); await flush(); assert.deepEqual(started, ["1", "4", "2", "3"]);
	assert.deepEqual(errors, []);
});
test("durable queued requests are reported interrupted after restart, never automatically exported", async t => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "se-queue-")), file = path.join(dir, "queue.json");
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	const interrupted = [], started = [];
	const hooks = { run: async item => started.push(item.id), interrupted: async item => interrupted.push(item),
		busyInstances: () => [1], error: error => { throw error; } };
	const before = new TransferRequestQueue(hooks); await before.init(file); await before.add(entry("1")); before.stop();
	assert.equal(JSON.parse(await fs.readFile(file, "utf8")).entries.length, 1);
	const after = new TransferRequestQueue(hooks); t.after(() => after.stop()); await after.init(file);
	await after.pump(); assert.deepEqual(started, []); assert.equal(interrupted[0].operation.status, "queued");
	assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")).entries, []);
});
test("queued markers stay at the source in both directions, without suggesting validation", () => {
	const phase = shipPhaseFor("queued"); assert.equal(phase.distance, 0); assert.equal(phase.label, "queued");
	assert.equal(phase.terminal, false);
	const ships = [{ status: "queued", platformName: "one" }, { status: "queued", platformName: "two" }];
	const forward = groupEdgeShips(ships, () => false), reverse = groupEdgeShips(ships, () => true);
	assert.equal(forward.markers[0].count, 2); assert.equal(forward.markers[0].distance, 0);
	assert.equal(reverse.markers[0].distance, 1); assert.equal(reverse.markers[0].label, "queued");
});
test("duplicate admission returns the same request, competing destinations are refused", async t => {
	const noop = () => {};
	const plugin = { logger: { info: noop, warn: noop, error: noop }, activeTransfers: new Map(), transactionLogs: new Map(),
		persistedTransactionLogs: [], platformStorage: new Map(), pendingTransfers: new Map(),
		controller: { instances: new Map([1, 2, 3].map(id => [id, { id, isDeleted: false }])) },
		isInstanceOnline: () => true, autoPauseRefusal: async () => null, platformTree: { resolvePlatformUid: async (_id, index, _force, uid) => uid || `fixture:${index}`, resolveInstanceName: id => `instance-${id}` },
		subscriptions: { emitTransferUpdate: noop, queueTreeBroadcast: noop },
		txLogger: { ...require("./timing-harness.cjs").makeTimingHarness(), logTransactionEvent: noop, persistTransactionLog: async () => {} } };
	const orchestrator = new TransferOrchestrator(plugin, messages); t.after(() => orchestrator.requestQueue.stop());
	let sends = 0; orchestrator.handleStartPlatformTransferRequestMeasured = async () => { sends++; return { success: true }; };
	const request = { sourceInstanceId: 1, sourcePlatformIndex: 5, targetInstanceId: 2 };
	const [first, duplicate] = await Promise.all([orchestrator.handleStartPlatformTransferRequest(request), orchestrator.handleStartPlatformTransferRequest(request)]);
	assert.equal(first.success, true); assert.equal(duplicate.transferId, first.transferId);
	assert.equal(orchestrator.requestQueue.entries.size, 1); assert.equal(plugin.activeTransfers.size, 1);
	const operation = plugin.activeTransfers.get(first.transferId);
	assert.equal((await orchestrator.handleStartPlatformTransferRequest({ ...request, targetInstanceId: 3 })).success, false);
	await orchestrator.requestQueue.pump(); await flush(); assert.equal(sends, 1);
	assert.equal(plugin.activeTransfers.get(first.transferId), operation, "Replay must not replace the active record");
});

test("rejection before queue admission retains observation without running export", async t => {
	const rejected = [], warnings = [];
	const plugin = {
		logger: { warn: value => warnings.push(value), error: () => {} },
		controller: { instances: new Map([1, 2].map(id => [id, { id }])) },
		isInstanceOnline: () => false,
		txLogger: { ...require("./timing-harness.cjs").makeTimingHarness(),
			rejectObservation: async (...args) => rejected.push(args) },
	};
	const orchestrator = new TransferOrchestrator(plugin, messages);
	t.after(() => orchestrator.requestQueue.stop());
	orchestrator.handleStartPlatformTransferRequestMeasured = async () => assert.fail("Rejected request must not export");
	const request = { sourceInstanceId: 1, sourcePlatformIndex: 5, targetInstanceId: 2 };
	const result = await orchestrator.handleStartPlatformTransferRequest(request);
	assert.equal(result.success, false);
	assert.equal(rejected.length, 1);
	assert.match(rejected[0][0], /^request:/);
	assert.deepEqual(rejected[0][1], request);
	assert.equal(rejected[0][2], result.error);
	assert.equal(orchestrator.requestQueue.entries.size, 0);
	plugin.txLogger.rejectObservation = async () => { throw new Error("Telemetry unavailable"); };
	assert.equal((await orchestrator.handleStartPlatformTransferRequest(request)).success, false);
	assert.match(warnings[0], /Telemetry unavailable/);
});

test("an auto-paused source or destination is refused before queue admission, and again before export", async t => {
	const noop = () => {};
	const autoPaused = new Set(), sent = [];
	const plugin = { logger: { info: noop, warn: noop, error: noop }, activeTransfers: new Map(), transactionLogs: new Map(),
		persistedTransactionLogs: [], platformStorage: new Map(), pendingTransfers: new Map(),
		controller: { instances: new Map([1, 2].map(id => [id, { id, isDeleted: false }])),
			sendTo: async (_target, message) => { sent.push(message.constructor.name); return { success: false, error: "not reached" }; } },
		isInstanceOnline: () => true,
		autoPauseRefusal: async (id, role) => (autoPaused.has(id) ? `${role} instance-${id} has auto-pause on` : null),
		platformTree: { resolvePlatformUid: async (_id, index, _force, uid) => uid || `fixture:${index}`, resolveInstanceName: id => `instance-${id}`,
			resolveTargetInstance: id => ({ id, instance: {} }) },
		subscriptions: { emitTransferUpdate: noop, queueTreeBroadcast: noop },
		txLogger: { ...require("./timing-harness.cjs").makeTimingHarness(), logTransactionEvent: noop, persistTransactionLog: async () => {},
			rejectObservation: async () => {} } };
	const orchestrator = new TransferOrchestrator(plugin, messages); t.after(() => orchestrator.requestQueue.stop());
	const request = { sourceInstanceId: 1, sourcePlatformIndex: 5, targetInstanceId: 2 };
	for (const [paused, role] of [[1, "source"], [2, "destination"]]) {
		autoPaused.clear(); autoPaused.add(paused);
		const result = await orchestrator.handleStartPlatformTransferRequest(request);
		assert.equal(result.success, false);
		assert.match(result.error, new RegExp(`${role} instance-${paused} has auto-pause on`));
		assert.match(result.error, /Nothing was locked or exported/);
		assert.equal(orchestrator.requestQueue.entries.size, 0);
		assert.equal(plugin.activeTransfers.size, 0);
	}
	for (const [paused, role] of [[1, "source"], [2, "destination"]]) {
		autoPaused.clear(); autoPaused.add(paused);
		const result = await orchestrator.handleStartPlatformTransferRequestMeasured(request, `request:${role}`);
		assert.equal(result.success, false);
		assert.match(result.error, new RegExp(`${role} instance-${paused} has auto-pause on`));
	}
	assert.deepEqual(sent, [], "no export request reaches an instance while either end is auto-paused");
});
