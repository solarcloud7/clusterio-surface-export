"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ClusterPause } = require("../dist/node/lib/cluster-pause.js");

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };

async function harness({ enabled = true, restored = null, instances, ready = null, seed = [] } = {}) {
	let now = 0;
	let nextTimer = 1;
	const timers = new Map();
	const sent = [], events = [], info = [], warn = [], checkpoints = [];
	const replies = new Map();
	const world = {
		enabled,
		countdownMs: 30000,
		instances: instances ?? [{ id: 1, name: "one", loaded: true, state: "running" }, { id: 2, name: "two", loaded: true, state: "running" }],
	};
	const machine = new ClusterPause({
		enabled: () => world.enabled,
		countdownMs: () => world.countdownMs,
		instances: () => world.instances,
		send: async (id, paused) => {
			sent.push([id, paused]);
			const reply = replies.get(id);
			return reply ? reply(paused) : paused;
		},
		emit: event => events.push(event),
		checkpoint: async paused => {
			checkpoints.push({ paused: [...paused], sentBefore: sent.length });
			const gate = world.checkpointGate;
			world.checkpointGate = null;
			if (gate) await gate;
			if (world.checkpointError) throw new Error(world.checkpointError);
		},
		nowMs: () => now,
		wallClockMs: () => 1_000_000 + now,
		setTimer: (callback, durationMs) => { const id = nextTimer++; timers.set(id, { callback, at: now + durationMs }); return id; },
		clearTimer: id => timers.delete(id),
		logger: { info: message => info.push(message), warn: message => warn.push(message) },
	}, restored);
	const advance = async durationMs => {
		now += durationMs;
		for (const [id, timer] of [...timers]) {
			if (timer.at <= now) { timers.delete(id); timer.callback(); }
		}
		await settle();
	};
	machine.seed(seed);
	for (const instance of world.instances) {
		if (ready ? ready.includes(instance.id) : instance.loaded && instance.state === "running") machine.onInstanceReady(instance.id);
	}
	await settle();
	sent.length = 0;
	return { machine, world, sent, events, info, warn, replies, timers, checkpoints, advance };
}

function participant(holds = []) {
	const calls = [];
	return {
		holds, calls,
		listHolds() { calls.push("listHolds"); return this.holds; },
		onPhase(event) { calls.push(`onPhase:${event.phase}`); },
	};
}

async function drainToPause(h, p) {
	h.machine.start();
	h.machine.registerParticipant("se", p);
	await h.advance(30000);
	await settle();
}

test("a join during the countdown cancels it and nothing is paused", async () => {
	const h = await harness({ seed: [[1, "Solar"]] });
	h.machine.start();
	h.machine.onPlayerEvent(1, "leave", "Solar");
	assert.equal(h.machine.currentPhase, "countdown");
	assert.equal(h.events.at(-1).reason, "last_player_left");
	await h.advance(10000);
	h.machine.onPlayerEvent(2, "join", "Ada");
	assert.equal(h.machine.currentPhase, "running");
	assert.equal(h.events.at(-1).reason, "player_joined");
	assert.equal(h.timers.size, 0);
	await h.advance(60000);
	assert.deepEqual(h.sent, []);
});

test("draining waits on every hold, tells participants before reading holds, then pauses every loaded running instance", async () => {
	const h = await harness({ instances: [
		{ id: 1, name: "one", loaded: true, state: "running" },
		{ id: 2, name: "two", loaded: true, state: "running" },
		{ id: 3, name: "three", loaded: false, state: "running" },
		{ id: 4, name: "four", loaded: true, state: "stopped" },
	] });
	const p = participant([{ reason: "transfer awaiting_validation", ref: "1:abc" }]);
	await drainToPause(h, p);
	assert.equal(h.machine.currentPhase, "draining");
	assert.equal(h.events.at(-1).reason, "countdown_elapsed");
	const drainingAt = p.calls.indexOf("onPhase:draining");
	assert.ok(drainingAt >= 0 && p.calls.indexOf("listHolds", drainingAt) > drainingAt, p.calls.join(","));
	h.machine.poll();
	await settle();
	assert.deepEqual(h.sent, []);
	assert.deepEqual(h.machine.status().holds, [{ participant: "se", reason: "transfer awaiting_validation", ref: "1:abc" }]);
	p.holds = [];
	h.machine.holdsChanged("se");
	await settle();
	assert.equal(h.machine.currentPhase, "paused");
	assert.deepEqual(h.sent, [[1, true], [2, true]]);
	assert.deepEqual(h.events.at(-1).confirmed, [1, 2]);
	assert.equal(h.events.at(-1).reason, "holds_cleared");
	assert.deepEqual(h.machine.status().notLoaded.map(entry => entry.instanceId), [3]);
	h.machine.onPlayerEvent(3, "join", "Solar");
	await settle();
	assert.equal(h.machine.currentPhase, "running");
	assert.deepEqual(h.sent.slice(2), [[1, false], [2, false]]);
	assert.deepEqual(h.events.at(-1).paused, []);
});

test("a participant that throws or returns no list counts as holding, is named in status and logged once", async () => {
	for (const listHolds of [() => { throw new Error("broken"); }, () => undefined]) {
		const h = await harness();
		h.machine.start();
		h.machine.registerParticipant("bad", { listHolds, onPhase() {} });
		await h.advance(30000);
		h.machine.poll();
		h.machine.poll();
		await settle();
		assert.equal(h.machine.currentPhase, "draining");
		assert.deepEqual(h.sent, []);
		const hold = h.machine.status().holds.find(entry => entry.participant === "bad");
		assert.equal(hold.reason, "participant state unavailable");
		assert.equal(h.warn.filter(message => message.includes("participant bad counts as holding")).length, 1);
	}
});

test("a failed pause request unpauses every instance that may have paused, returns to running and waits for the next change", async () => {
	const h = await harness();
	h.replies.set(2, async paused => { if (paused) throw new Error("timed out"); return false; });
	await drainToPause(h, participant());
	assert.equal(h.machine.currentPhase, "running");
	assert.equal(h.events.find(event => event.reason === "pause_failed")?.phase, "running");
	assert.deepEqual(h.sent.filter(([, paused]) => !paused).map(([id]) => id).sort(), [1, 2]);
	assert.match(h.machine.status().lastError, /two \(2\): timed out/);
	h.machine.poll();
	await h.advance(60000);
	assert.equal(h.machine.currentPhase, "running");
	assert.equal(h.sent.filter(([, paused]) => paused).length, 2);
	h.machine.onInstanceStatus(2, "running");
	assert.equal(h.machine.currentPhase, "countdown");
});

test("an unpause that is not confirmed keeps the instance listed as paused and is retried", async () => {
	const h = await harness();
	await drainToPause(h, participant());
	let fail = true;
	h.replies.set(1, async paused => { if (!paused && fail) throw new Error("rcon unavailable"); return paused; });
	h.machine.onPlayerEvent(2, "join", "Solar");
	await settle();
	assert.deepEqual(h.events.at(-1).paused, [1]);
	fail = false;
	h.machine.poll();
	await settle();
	assert.deepEqual(h.machine.state().paused, []);
	assert.deepEqual(h.events.at(-1).paused, []);
});

test("a controller restart starts running, keeps seeded players and resumes the instances the previous run had paused", async () => {
	const h = await harness({ restored: { paused: [2, "bad"] }, ready: [] });
	h.machine.seed([[1, "Solar"]]);
	h.machine.start();
	await settle();
	assert.equal(h.events[0].phase, "running");
	assert.equal(h.events[0].reason, "controller_start");
	assert.deepEqual(h.sent, [[2, false]]);
	assert.deepEqual(h.machine.state().paused, []);
	h.machine.poll();
	assert.equal(h.machine.currentPhase, "running");
	assert.deepEqual(h.machine.state().online, [{ instanceId: 1, name: "one", players: ["solar"] }]);
});

test("disabled sends nothing, and turning it off while paused resumes every instance", async () => {
	const off = await harness({ enabled: false });
	off.machine.start();
	off.machine.poll();
	off.machine.onPlayerEvent(1, "leave", "Solar");
	await off.advance(120000);
	assert.equal(off.machine.currentPhase, "running");
	assert.deepEqual(off.sent, []);
	assert.throws(() => off.machine.control("pause"), /turned off/);
	const on = await harness();
	await drainToPause(on, participant());
	assert.equal(on.machine.currentPhase, "paused");
	on.world.enabled = false;
	on.machine.onConfigChanged();
	await settle();
	assert.equal(on.machine.currentPhase, "running");
	assert.ok(on.events.some(event => event.phase === "running" && event.reason === "disabled"));
	assert.deepEqual(on.machine.state().paused, []);
});

test("an instance in an unknown state blocks the countdown and cancels draining", async () => {
	const h = await harness();
	h.world.instances[1] = { ...h.world.instances[1], state: "unknown" };
	h.machine.start();
	h.machine.poll();
	assert.equal(h.machine.currentPhase, "running");
	h.world.instances[1] = { ...h.world.instances[1], state: "running" };
	h.machine.registerParticipant("se", participant([{ reason: "busy" }]));
	await h.advance(30000);
	assert.equal(h.machine.currentPhase, "draining");
	h.world.instances[1] = { ...h.world.instances[1], state: "unknown" };
	h.machine.poll();
	assert.equal(h.machine.currentPhase, "running");
	assert.equal(h.events.at(-1).reason, "unknown_state");
	assert.deepEqual(h.sent, []);
});

test("an instance that starts while paused is paused only once no hold remains", async () => {
	const h = await harness();
	const p = participant();
	await drainToPause(h, p);
	h.world.instances.push({ id: 3, name: "three", loaded: true, state: "running" });
	p.holds = [{ reason: "instance reconciling its save", ref: "3" }];
	h.machine.onInstanceReady(3);
	await settle();
	assert.equal(h.sent.some(([id]) => id === 3), false);
	p.holds = [];
	h.machine.holdsChanged("se");
	await settle();
	assert.deepEqual(h.sent.at(-1), [3, true]);
	assert.deepEqual(h.events.at(-1).paused, [1, 2, 3]);
	assert.equal(h.machine.currentPhase, "paused");
});

test("commands: pause is refused while anyone is online, resume keeps the countdown off until the next join or leave", async () => {
	const h = await harness({ seed: [[1, "Solar"]] });
	h.machine.start();
	assert.throws(() => h.machine.control("pause"), /Players are online \(solar\)/);
	h.machine.onPlayerEvent(1, "leave", "Solar");
	h.machine.registerParticipant("se", participant());
	h.machine.control("pause");
	await settle();
	assert.equal(h.machine.currentPhase, "paused");
	assert.equal(h.events.find(event => event.phase === "draining").reason, "command");
	const status = h.machine.control("resume");
	await settle();
	assert.equal(status.phase, "running");
	assert.match(status.hold, /Resumed by an administrator/);
	h.machine.poll();
	await h.advance(60000);
	assert.equal(h.machine.currentPhase, "running");
	h.machine.onPlayerEvent(1, "join", "Solar");
	h.machine.onPlayerEvent(1, "leave", "Solar");
	assert.equal(h.machine.currentPhase, "countdown");
});

test("a participant registering while draining is told the current phase at once", async () => {
	const h = await harness();
	await drainToPause(h, participant([{ reason: "busy" }]));
	const late = participant();
	h.machine.registerParticipant("late", late);
	assert.equal(late.calls[0], "onPhase:draining");
});

test("an instance that has not reported ready is neither paused nor a target", async () => {
	const h = await harness({ ready: [1] });
	await drainToPause(h, participant());
	assert.equal(h.machine.currentPhase, "paused");
	assert.deepEqual(h.sent, [[1, true]]);
	assert.deepEqual(h.machine.status().notReady.map(entry => entry.instanceId), [2]);
	const none = await harness({ ready: [] });
	none.machine.start();
	none.machine.registerParticipant("se", participant());
	none.machine.poll();
	await none.advance(60000);
	assert.equal(none.machine.currentPhase, "running");
	assert.throws(() => none.machine.control("pause"), /reported ready/);
	assert.deepEqual(none.sent, []);
});

test("pause targets are recorded before any pause order, and a failed record sends none", async () => {
	const h = await harness();
	await drainToPause(h, participant());
	assert.deepEqual(h.checkpoints, [{ paused: [1, 2], sentBefore: 0 }]);
	const broken = await harness();
	broken.world.checkpointError = "disk full";
	await drainToPause(broken, participant());
	assert.deepEqual(broken.sent, []);
	assert.equal(broken.machine.currentPhase, "running");
	assert.match(broken.machine.status().lastError, /could not be recorded before pausing: disk full/);
	assert.deepEqual(broken.machine.state().paused, []);
});

test("an instance stopped while paused stays listed until it confirms a resume; a deleted one is dropped", async () => {
	const h = await harness();
	await drainToPause(h, participant());
	h.world.instances[1] = { ...h.world.instances[1], state: "stopped" };
	h.machine.onInstanceStatus(2, "stopped");
	h.machine.onPlayerEvent(1, "join", "Solar");
	await settle();
	assert.deepEqual(h.sent.filter(([, paused]) => !paused), [[1, false]]);
	assert.deepEqual(h.machine.state().paused, [2]);
	h.world.instances[1] = { ...h.world.instances[1], state: "running" };
	h.machine.onInstanceStatus(2, "running");
	h.machine.onInstanceReady(2);
	await settle();
	assert.deepEqual(h.machine.state().paused, []);
	const deleted = await harness();
	deleted.replies.set(1, async paused => { if (!paused) throw new Error("unreachable"); return true; });
	await drainToPause(deleted, participant());
	deleted.machine.onPlayerEvent(2, "join", "Solar");
	await settle();
	assert.deepEqual(deleted.machine.state().paused, [1]);
	deleted.machine.onInstanceStatus(1, "deleted");
	assert.deepEqual(deleted.machine.state().paused, []);
});

test("a ready report resumes the instance even while cluster pause is turned off", async () => {
	const h = await harness({ enabled: false, ready: [] });
	h.machine.onInstanceReady(1);
	await settle();
	assert.deepEqual(h.sent, [[1, false]]);
	assert.equal(h.machine.currentPhase, "running");
});

test("a superseded pause attempt never removes the targets a newer attempt recorded", async () => {
	const h = await harness();
	let release;
	h.world.checkpointGate = new Promise(resolve => { release = resolve; });
	await drainToPause(h, participant());
	assert.equal(h.machine.currentPhase, "draining");
	h.machine.onPlayerEvent(1, "join", "Solar");
	await settle();
	h.machine.onPlayerEvent(1, "leave", "Solar");
	h.machine.control("pause");
	await settle();
	assert.equal(h.machine.currentPhase, "paused");
	assert.deepEqual(h.machine.state().paused, [1, 2]);
	release();
	await settle();
	assert.equal(h.machine.currentPhase, "paused");
	assert.deepEqual(h.machine.state().paused, [1, 2]);
	assert.deepEqual(h.events.at(-1).paused, [1, 2]);
});

test("an instance that reports ready while the cluster is pausing cancels the pause and is itself resumed", async () => {
	const h = await harness({ instances: [
		{ id: 1, name: "one", loaded: true, state: "running" },
		{ id: 2, name: "two", loaded: true, state: "running" },
		{ id: 3, name: "three", loaded: true, state: "running" },
	], ready: [1, 2] });
	let release;
	h.world.checkpointGate = new Promise(resolve => { release = resolve; });
	await drainToPause(h, participant());
	h.machine.onInstanceReady(3);
	await settle();
	release();
	await settle();
	assert.equal(h.machine.currentPhase, "running");
	assert.ok(h.sent.some(([id, paused]) => id === 3 && paused === false), JSON.stringify(h.sent));
	assert.ok(!h.sent.some(([id, paused]) => id === 3 && paused === true), JSON.stringify(h.sent));
});
