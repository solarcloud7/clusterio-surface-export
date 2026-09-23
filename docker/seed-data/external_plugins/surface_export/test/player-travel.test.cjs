const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ControllerPlugin } = require("../dist/node/controller");

function setup() {
	const instances = new Map([1, 2, 3].map(id => [id, { id, config: { get: key => key === "instance.name" ? `fact${id}` : true } }]));
	const sent = [], warnings = [];
	const plugin = Object.create(ControllerPlugin.prototype);
	plugin.playerLocations = new Map();
	plugin.controller = { instances, sendTo: async (target, request) => { sent.push({ target, request }); return { success: true }; } };
	plugin.logger = { warn: message => warnings.push(message) };
	return { plugin, sent, warnings, emit: (id, type) => plugin.onPlayerEvent(instances.get(id), { name: "Solar", type }) };
}

test("travel is announced only after joining another instance, including a late source leave", async () => {
	const { emit, sent } = setup();
	await emit(1, "join");
	await emit(1, "leave");
	await emit(1, "join");
	assert.equal(sent.length, 0);
	await emit(2, "join");
	await emit(1, "leave");
	await emit(2, "join");
	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0].target, { instanceId: 2 });
	assert.deepEqual(sent[0].request.toJSON(), { playerName: "Solar", sourceName: "fact1", targetName: "fact2" });
	await emit(3, "join");
	assert.equal(sent[1].request.sourceName, "fact2");
});

test("a first observed departure establishes the source, but other player events do not", async () => {
	const { emit, sent } = setup();
	await emit(1, "promote");
	await emit(2, "join");
	assert.equal(sent.length, 0);
	const fresh = setup();
	await fresh.emit(1, "leave");
	assert.equal(fresh.sent.length, 0);
	await fresh.emit(2, "join");
	assert.equal(fresh.sent.length, 1);
});

test("announcement failure does not replay a completed arrival on another join event", async () => {
	const { plugin, emit, warnings } = setup();
	let attempts = 0;
	plugin.controller.sendTo = async () => { attempts++; throw Error("offline"); };
	await emit(1, "join");
	await emit(2, "join");
	await emit(2, "join");
	assert.equal(attempts, 1);
	assert.match(warnings[0], /offline/);
});
