const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {setImmediate: settle} = require("node:timers/promises");
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
	await settle();
	assert.match(warnings[0], /offline/);
});

for (const order of ["join-first", "leave-first"]) {
	test(`persisted source survives controller restart and ${order}`, async t => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "se-travel-"));
		t.after(() => fs.rm(directory, {recursive: true, force: true}));
		const file = path.join(directory, "locations.json");
		const first = setup();
		await first.plugin.loadPlayerLocations(file);
		await first.emit(1, "join");
		const restarted = setup();
		await restarted.plugin.loadPlayerLocations(file);
		if (order === "leave-first") await restarted.emit(1, "leave");
		await restarted.emit(2, "join");
		if (order === "join-first") await restarted.emit(1, "leave");
		await restarted.emit(2, "join");
		assert.equal(restarted.sent.length, 1);
		assert.equal(restarted.sent[0].request.sourceName, "fact1");
		const again = setup();
		await again.plugin.loadPlayerLocations(file);
		await again.emit(2, "join");
		assert.equal(again.sent.length, 0);
		await again.emit(3, "join");
		assert.equal(again.sent[0].request.sourceName, "fact2");
	});
}

test("slow announcements cannot hold the player hook or manufacture a source from stale online records", async () => {
	const {plugin, emit} = setup();
	plugin.controller.users = {getByName: () => ({instances: new Set([99]), instanceStats: new Map([[99, {lastJoinAt: new Date(9999999999999)}]])})};
	let sends = 0, resolve;
	plugin.controller.sendTo = () => { sends++; return new Promise(done => {resolve = done;}); };
	await emit(1, "join");
	assert.equal(sends, 0);
	await emit(2, "join");
	assert.equal(sends, 1);
	await emit(2, "join");
	assert.equal(sends, 1);
	resolve({success: true});
});

test("unreadable history is retained, and subsequent observations work without guessing a source", async t => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "se-travel-"));
	t.after(() => fs.rm(directory, {recursive: true, force: true}));
	const file = path.join(directory, "locations.json");
	await fs.writeFile(file, "broken history");
	const {plugin, emit, sent, warnings} = setup();
	await plugin.loadPlayerLocations(file);
	await emit(1, "join");
	assert.equal(sent.length, 0);
	await emit(2, "join");
	assert.equal(sent.length, 1);
	assert.equal(await fs.readFile(file, "utf8"), "broken history");
	assert.match(warnings[0], /history unavailable/);
});
