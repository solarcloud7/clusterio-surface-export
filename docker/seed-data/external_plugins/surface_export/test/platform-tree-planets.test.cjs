"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { PlatformTree } = require(path.join(__dirname, "..", "dist", "node", "lib", "platform-tree.js"));

function makeTree({ instances, controllerConfig = {}, modPacks, warnings = [] }) {
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
			modPacks,
			async sendTo() { throw new Error("stopped instances are not polled"); },
		},
		activeTransfers: new Map(),
		platformDepartureTimes: new Map(),
		logger: { info() {}, verbose() {}, warn: message => warnings.push(message) },
	};
	return new PlatformTree(plugin, { InstanceListPlatformsRequest: class {} });
}

function pack(value) {
	return { settings: { startup: new Map(value === undefined ? [] : [["surfexp-gateway-instances", { value }]]) } };
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

test("a server's portal comes from the server destinations of the mod pack it runs", async () => {
	const modPacks = new Map([
		[7, pack("1=Forge,2,3=Cinder")],
		[8, pack("3=Elsewhere,1=Other")],
	]);
	const tree = makeTree({
		instances: [[1, { "factorio.mod_pack_id": 7 }], [2, { "factorio.mod_pack_id": null }], [3, { "factorio.mod_pack_id": 8 }]],
		controllerConfig: { "controller.default_mod_pack_id": 7 },
		modPacks,
	});
	assert.deepEqual((await nodes(tree)).map(node => node.destination), [
		{ label: "Forge", colour: "blue" },
		{ label: "Server 2", colour: "green" },
		{ label: "Elsewhere", colour: "blue" },
	], "an instance without a pack of its own uses the controller's default pack");
});

test("a server without a destination entry, pack or setting has no portal", async () => {
	const warnings = [];
	const tree = makeTree({
		instances: [[1, { "factorio.mod_pack_id": 7 }], [2, { "factorio.mod_pack_id": 9 }], [3, { "factorio.mod_pack_id": 6 }], [4, {}]],
		modPacks: new Map([[7, pack("5=Five")], [6, pack(undefined)]]),
		warnings,
	});
	assert.deepEqual((await nodes(tree)).map(node => node.destination), [null, null, null, null]);
	assert.deepEqual(warnings, []);
});

test("an unreadable mod pack store leaves the portal empty and is logged", async () => {
	const warnings = [];
	const tree = makeTree({
		instances: [[1, { "factorio.mod_pack_id": 7 }]],
		modPacks: { get() { throw new Error("datastore unavailable"); } },
		warnings,
	});
	assert.equal((await nodes(tree))[0].destination, null);
	assert.match(warnings.join("\n"), /server destination of instance 1: datastore unavailable/);
});

test("a controller without a mod pack store still builds the tree", async () => {
	const tree = makeTree({ instances: [[1, { "factorio.mod_pack_id": 7 }]] });
	assert.equal((await nodes(tree))[0].destination, null);
});
