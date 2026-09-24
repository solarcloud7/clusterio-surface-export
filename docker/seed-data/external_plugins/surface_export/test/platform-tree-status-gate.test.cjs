"use strict";


const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { PlatformTree } = require(path.join(__dirname, "..", "dist", "node", "lib", "platform-tree.js"));

class StubListPlatformsRequest {
	constructor(json) {
		this.forceName = json.forceName;
	}
}

function makeInstance(id, hostId, status, debugMode) {
	return {
		id,
		isDeleted: false,
		status,
		gamePort: 34100,
		config: {
			get(key) {
				if (key === "instance.name") { return `instance-${id}`; }
				if (key === "instance.assigned_host") { return hostId; }
				if (key === "surface_export.debug_mode") { return debugMode; }
				return undefined;
			},
		},
	};
}

function makeTree(statuses, appliedDebug = new Map(), appliedAutoPause = new Map()) {
	const polled = [];
	const hosts = new Map([[1, { id: 1, name: "host-1", connected: true, isDeleted: false }]]);
	const instances = new Map(statuses.map(([id, status, debugMode]) => [id, makeInstance(id, 1, status, debugMode)]));
	const plugin = {
		controller: {
			hosts,
			instances,
			async sendTo(target) {
				polled.push(target.instanceId);
				return { platforms: [], debugMode: appliedDebug.get(target.instanceId), autoPause: appliedAutoPause.get(target.instanceId) };
			},
		},
		activeTransfers: new Map(),
		platformDepartureTimes: new Map(),
		logger: { info() {}, warn() {}, verbose() {} },
	};
	const tree = new PlatformTree(plugin, { InstanceListPlatformsRequest: StubListPlatformsRequest });
	return { tree, polled };
}

test("an instance that is not running is never polled for platforms", async () => {
	const { tree, polled } = makeTree([[10, "init"], [11, "stopped"], [12, "running"]]);
	const result = await tree.buildPlatformTree("player");
	assert.deepEqual(polled, [12],
		"only the running instance may receive InstanceListPlatformsRequest — polling an instance in "
		+ "init/stopped errors with 'Expected state running,stopping but state is init' on every cluster boot");
	const nodes = result.hosts[0].instances;
	const initNode = nodes.find(node => node.instanceId === 10);
	assert.deepEqual(initNode.platforms, []);
	assert.equal(initNode.platformError, null,
		"a not-yet-running instance is not an error condition — the tree already carries its status");
});

test("a running instance on a connected host is polled", async () => {
	const { tree, polled } = makeTree([[20, "running"]]);
	await tree.buildPlatformTree("player");
	assert.deepEqual(polled, [20]);
});

test("the web tree exposes applied debug state rather than settings awaiting restart", async () => {
	const { tree } = makeTree([[1, "running", true], [2, "running", false], [3, "stopped", true], [4, "running", true]],
		new Map([[1, false], [2, true], [3, true]]));
	const result = await tree.buildPlatformTree("player");
	assert.deepEqual(result.hosts[0].instances.map(instance => instance.debugMode), [false, true, false, false]);
});

test("the web tree marks auto-pause only for a running server that reports it", async () => {
	const { tree } = makeTree([[1, "running"], [2, "running"], [3, "stopped"], [4, "running"]], new Map(),
		new Map([[1, true], [2, false], [3, true], [4, null]]));
	const result = await tree.buildPlatformTree("player");
	assert.deepEqual(result.hosts[0].instances.map(instance => instance.autoPause), [true, false, false, false]);
});

test("tree status joins the selected copy rather than a matching name or index", () => {
	const { tree } = makeTree([[20, "running"]]);
	tree.plugin.activeTransfers.set("20:job", {transferId: "20:job", sourceInstanceId: 20,
		platformIndex: 3, platformUid: "original", platformName: "same", forceName: "player", status: "preparing"});
	const result = tree.applyActiveTransferState([
		{platformIndex: 3, platformUid: "original", platformName: "renamed", forceName: "player"},
		{platformIndex: 4, platformUid: "other", platformName: "same", forceName: "player"},
		{platformIndex: 3, platformUid: "replacement", platformName: "same", forceName: "player"},
		{platformIndex: 3, platformUid: "original", platformName: "same", forceName: "other-force"},
	], 20);
	assert.deepEqual(result.map(p => p.transferId), ["20:job", null, null, null]);
});

test("source UID survives request serialization and a delayed admission", async () => {
	const messages = require(path.join(__dirname, "..", "dist", "node", "messages.js"));
	for (const Message of [messages.StartPlatformTransferRequest, messages.ExportPlatformForDownloadRequest]) {
		const encoded = new Message({sourceInstanceId: 20, sourcePlatformIndex: 3, sourcePlatformUid: "selected", targetInstanceId: 21}).toJSON();
		assert.equal(Message.fromJSON(encoded).sourcePlatformUid, "selected");
	}
	const message = new messages.ExportPlatformRequest({platformIndex: 3, platformUid: "selected"});
	assert.equal(messages.ExportPlatformRequest.fromJSON(message.toJSON()).platformUid, "selected");
	const { tree, polled } = makeTree([[20, "running"]]);
	assert.equal(await tree.resolvePlatformUid(20, 3, "player", "selected"), "selected");
	assert.deepEqual(polled, [], "a stale selection must not silently adopt the latest UID");
	await assert.rejects(tree.resolvePlatformUid(20, 3, "player"), /identity is unavailable/);
});
