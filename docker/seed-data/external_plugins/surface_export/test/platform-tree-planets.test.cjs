"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { PlatformTree } = require(path.join(__dirname, "..", "dist", "node", "lib", "platform-tree.js"));

function makeTree({ instances, controllerConfig = {}, warnings = [] }) {
	const plugin = {
		controller: {
			hosts: new Map([[1, { id: 1, name: "host-1", connected: true, isDeleted: false }]]),
			instances: new Map(instances.map(([id, config]) => [id, {
				id,
				isDeleted: false,
				status: "stopped",
				gamePort: null,
				config: { get: key => key === "instance.name" ? `instance-${id}` : key === "instance.assigned_host" ? 1 : config[key] },
			}])),
			config: { get: key => controllerConfig[key] },
			async sendTo() { throw new Error("stopped instances are not polled"); },
		},
		activeTransfers: new Map(),
		platformDepartureTimes: new Map(),
		logger: { info() {}, verbose() {}, warn: message => warnings.push(message) },
	};
	return new PlatformTree(plugin, { InstanceListPlatformsRequest: class {} });
}

async function nodes(tree) {
	return (await tree.buildPlatformTree("player")).hosts[0].instances;
}

test("each server carries its configured default planet and its unavailable planets", async () => {
	const tree = makeTree({ instances: [
		[1, { "surface_export.default_planet": " vulcanus ", "surface_export.disabled_planets": " gleba, ,aquilo ,, " }],
		[2, { "surface_export.default_planet": "", "surface_export.disabled_planets": "" }],
		[3, {}],
	] });
	assert.deepEqual((await nodes(tree)).map(node => [node.defaultPlanet, node.disabledPlanets]), [
		["vulcanus", ["gleba", "aquilo"]],
		["nauvis", []],
		["nauvis", []],
	]);
});

test("a server's portal colour and label come from the controller's portal assignment", async () => {
	const tree = makeTree({ instances: [[1, {}], [2, {}], [3, {}]] });
	tree.plugin.gatewayConfig = { portalOf: id => id === 3 ? null : { slot: id, colour: id === 1 ? "blue" : "green", label: `instance-${id}` } };
	assert.deepEqual((await nodes(tree)).map(node => node.portal), [
		{ slot: 1, colour: "blue", label: "instance-1" },
		{ slot: 2, colour: "green", label: "instance-2" },
		null,
	]);
});

test("an unreadable portal assignment leaves the portal empty and is logged", async () => {
	const warnings = [];
	const tree = makeTree({ instances: [[1, {}]], warnings });
	tree.plugin.gatewayConfig = { portalOf() { throw new Error("assignment unavailable"); } };
	assert.equal((await nodes(tree))[0].portal, null);
	assert.match(warnings.join("\n"), /portal colour of instance 1: assignment unavailable/);
});

test("a controller without gateway config still builds the tree", async () => {
	const tree = makeTree({ instances: [[1, {}]] });
	assert.equal((await nodes(tree))[0].portal, null);
});
