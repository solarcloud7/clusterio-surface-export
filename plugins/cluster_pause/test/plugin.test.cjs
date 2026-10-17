"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const messages = require("../dist/node/messages.js");
const { plugin } = require("../dist/node/index.js");
const { ControllerPlugin, CLUSTER_PAUSE_RENDEZVOUS, STATE_FILENAME, loadPersistedState, publishApi } = require("../dist/node/controller.js");
const { parseSetPausedReply } = require("../dist/node/instance.js");

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
const until = async (check, timeoutMs = 2000) => {
	const deadline = Date.now() + timeoutMs;
	while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
};
const quiet = { info() {}, warn() {}, error() {} };

test("every declared message round-trips through toJSON and fromJSON", () => {
	const samples = {
		ClusterPauseRequest: { paused: true },
		ClusterPauseStateEvent: { phase: "paused", sinceMs: 5, reason: "holds_cleared", online: [], holds: [{ participant: "se", reason: "x" }], confirmed: [1], paused: [1] },
		ClusterPauseInstanceReadyEvent: {},
		ClusterPauseStatusRequest: {},
		ClusterPauseControlRequest: { action: "resume" },
	};
	assert.deepEqual(plugin.messages.map(cls => cls.name).sort(), Object.keys(samples).sort());
	for (const cls of plugin.messages) {
		assert.equal(cls.plugin, "cluster_pause");
		const json = new cls(samples[cls.name]).toJSON();
		assert.deepEqual(cls.fromJSON(json).toJSON(), json, cls.name);
		for (const key of cls.jsonSchema.required ?? []) assert.ok(key in json, `${cls.name} omits ${key}`);
	}
	assert.equal(messages.ClusterPauseStateEvent.permission, "cluster_pause.view");
	assert.equal(messages.ClusterPauseControlRequest.permission, "cluster_pause.control");
	assert.deepEqual(Object.keys(plugin.controllerConfigFields).sort(),
		["cluster_pause.countdown_ms", "cluster_pause.enabled", "cluster_pause.hold_check_interval_ms"]);
	assert.equal(plugin.controllerConfigFields["cluster_pause.enabled"].initialValue, false);
});

test("participants that arrive before or after the plugin both register", () => {
	const host = {};
	const registered = [];
	const join = name => {
		const rendezvous = host[CLUSTER_PAUSE_RENDEZVOUS] ?? (host[CLUSTER_PAUSE_RENDEZVOUS] = { waiting: [] });
		const ready = api => api.registerParticipant(name, {});
		if (rendezvous.api) ready(rendezvous.api);
		else rendezvous.waiting.push(ready);
	};
	join("early");
	join("broken");
	host[CLUSTER_PAUSE_RENDEZVOUS].waiting[1] = () => { throw new Error("bad participant"); };
	const warnings = [];
	publishApi(host, { registerParticipant: name => registered.push(name), holdsChanged() {}, status() {} }, { warn: message => warnings.push(message) });
	join("late");
	assert.deepEqual(registered, ["early", "late"]);
	assert.match(warnings[0], /bad participant/);
	assert.equal(host[CLUSTER_PAUSE_RENDEZVOUS].waiting.length, 0);
});

test("the persisted state reads as absent, unreadable or a paused list", async t => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cluster-pause-"));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const file = path.join(directory, STATE_FILENAME);
	assert.equal(await loadPersistedState(file, quiet), null);
	await fs.writeFile(file, "{not json");
	assert.equal(await loadPersistedState(file, quiet), "unreadable");
	await fs.writeFile(file, JSON.stringify({ version: 2, paused: [] }));
	assert.equal(await loadPersistedState(file, quiet), "unreadable");
	await fs.writeFile(file, JSON.stringify({ version: 1, phase: "paused", sinceMs: 1, paused: [4] }));
	assert.deepEqual(await loadPersistedState(file, quiet), { paused: [4] });
});

test("the applied pause value is read from the Lua reply and refusals surface", () => {
	assert.equal(parseSetPausedReply('{"success":true,"paused":true}\n'), true);
	assert.equal(parseSetPausedReply('{"success":true,"paused":false}'), false);
	assert.throws(() => parseSetPausedReply('{"success":false,"error":"paused must be true or false"}'), /paused must be true or false/);
	assert.throws(() => parseSetPausedReply("Cannot execute command. Error: Unknown interface: cluster_pause"), /unreadable reply/);
});

function fakeController(directory, { users = [], enabled = true } = {}) {
	const handlers = new Map(), hooks = {}, sent = [], broadcasts = [];
	const config = new Map([["controller.database_directory", directory], ["cluster_pause.enabled", enabled],
		["cluster_pause.countdown_ms", 30000], ["cluster_pause.hold_check_interval_ms", 60000]]);
	const instanceConfig = id => ({ get: key => key === "instance.name" ? `dev${id}` : key === "instance.assigned_host" ? 1 : true });
	const controller = {
		config: { get: key => config.get(key) },
		users: { values: () => users[Symbol.iterator]() },
		instances: new Map([1, 2].map(id => [id, { id, isDeleted: false, status: "running", config: instanceConfig(id) }])),
		hosts: new Map([[1, { connected: true }]]),
		subscriptions: { handle: (cls, update) => handlers.set(`subscribe:${cls.name}`, update), broadcast: event => broadcasts.push(event) },
		handle: (cls, handler) => handlers.set(cls.name, handler),
		sendTo: (target, message) => {
			sent.push([target, message]);
			if (message instanceof messages.ClusterPauseRequest) return Promise.resolve({ paused: message.paused });
			return undefined;
		},
		hooks: new Proxy({}, { get: (_, name) => ({ attach: (_plugin, callback) => { hooks[name] = callback; } }) }),
	};
	return { controller, handlers, hooks, sent, broadcasts };
}

test("the controller plugin persists what it paused and a restarted controller resumes those instances", async t => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cluster-pause-"));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const first = fakeController(directory);
	const holds = [];
	first.controller[CLUSTER_PAUSE_RENDEZVOUS] = { waiting: [api => api.registerParticipant("se", { listHolds: () => holds, onPhase() {} })] };
	const loaded = await ControllerPlugin.fromContext({ controller: first.controller, logger: quiet, plugin: { name: "cluster_pause" } });
	assert.equal(ControllerPlugin.get(first.controller), loaded);
	assert.deepEqual(loaded.machine.status().participants, ["se"]);
	assert.equal(first.broadcasts[0].reason, "controller_start");
	for (const id of [1, 2]) await first.handlers.get("ClusterPauseInstanceReadyEvent")(new messages.ClusterPauseInstanceReadyEvent(), { id });
	await settle();
	await first.handlers.get("ClusterPauseControlRequest")(new messages.ClusterPauseControlRequest({ action: "pause" }));
	await until(() => loaded.machine.currentPhase === "paused");
	assert.equal(loaded.machine.currentPhase, "paused");
	assert.ok(first.sent.some(([target, message]) => target === "allInstances" && message.phase === "paused"));
	await loaded.onShutdown();
	assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, STATE_FILENAME), "utf8")).paused, [1, 2]);

	const second = fakeController(directory, { users: [{ name: "Solar", instances: new Set([1]) }] });
	const restarted = await ControllerPlugin.fromContext({ controller: second.controller, logger: quiet, plugin: { name: "cluster_pause" } });
	await settle();
	assert.equal(restarted.machine.currentPhase, "running");
	const resumed = second.sent.filter(([, message]) => message instanceof messages.ClusterPauseRequest).map(([target, message]) => [target.instanceId, message.paused]);
	assert.deepEqual(resumed, [[1, false], [2, false]]);
	assert.deepEqual(restarted.machine.state().online, [{ instanceId: 1, name: "dev1", players: ["solar"] }]);
	await second.hooks.playerEvent(second.controller.instances.get(1), { type: "leave", name: "Solar" });
	assert.equal(restarted.machine.currentPhase, "running", "no instance has reported ready to this controller yet");
	for (const id of [1, 2]) await second.handlers.get("ClusterPauseInstanceReadyEvent")(new messages.ClusterPauseInstanceReadyEvent(), { id });
	await until(() => restarted.machine.currentPhase === "countdown");
	assert.equal(restarted.machine.currentPhase, "countdown");
	await second.hooks.playerEvent(undefined, { type: "join", name: "Ghost" });
	assert.equal(restarted.machine.currentPhase, "countdown");
	await restarted.onShutdown();
});
