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

function makeInstance(id, hostId, status) {
	return {
		id,
		isDeleted: false,
		status,
		gamePort: 34100,
		config: {
			get(key) {
				if (key === "instance.name") { return `instance-${id}`; }
				if (key === "instance.assigned_host") { return hostId; }
				return undefined;
			},
		},
	};
}

function makeTree(statuses) {
	const polled = [];
	const hosts = new Map([[1, { id: 1, name: "host-1", connected: true, isDeleted: false }]]);
	const instances = new Map(statuses.map(([id, status]) => [id, makeInstance(id, 1, status)]));
	const plugin = {
		controller: {
			hosts,
			instances,
			async sendTo(target) {
				polled.push(target.instanceId);
				return { platforms: [] };
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
