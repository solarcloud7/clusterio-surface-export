"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const Module = require("node:module");
const originalLoad = Module._load;
class NoopMetric {
	labels() { return this; }
	inc() {}
	observe() {}
}
Module._load = function(request, parent, isMain) {
	if (request === "@clusterio/lib") {
		return { safeOutputFile: fs.writeFile, Counter: NoopMetric, Histogram: NoopMetric };
	}
	if (request === "@clusterio/controller") return { BaseControllerPlugin: class {} };
	return originalLoad.call(this, request, parent, isMain);
};
const { GatewayConfig } = require("../dist/node/lib/gateway-config");
const { ONE_GATE_NAME } = require("../dist/node/messages");
Module._load = originalLoad;

function addressFixture(settings = {}) {
	const config = new Map(Object.entries(settings));
	const instance = (id, hostId, gamePort) => ({ id, gamePort, config: { get: key => key === "instance.assigned_host" ? hostId : undefined } });
	const sends = [];
	const controller = {
		config: { get: key => config.get(key) },
		instances: new Map([[1, instance(1, 10, 34197)], [2, instance(2, 10, 34198)], [3, instance(3, 11, 34199)]]),
		hosts: new Map([[10, { publicAddress: "game.example.net" }], [11, {}]]),
		async sendTo(target, message) {
			sends.push({ target, message });
			return { success: true };
		},
	};
	const logger = Object.fromEntries(["info", "warn", "error", "verbose"].map(level => [level, () => {}]));
	const plugin = new GatewayConfig(controller, logger, { isInstanceOnline: () => true, resolveInstanceName: id => `instance-${id}` });
	return { plugin, controller, config, sends };
}

test("resolved gateway targets carry the destination join address", async () => {
	const { plugin, sends } = addressFixture();
	const view = await plugin.handleGetGatewayConfigRequest({ instanceId: 1 });
	assert.equal(view.gateways[0].gatewayName, ONE_GATE_NAME);
	assert.deepEqual(view.gateways[0].targets.map(entry => entry.address), ["game.example.net:34198", "localhost:34199"]);
	assert.equal(await plugin.pushGatewayConfigToInstance(1), null);
	assert.deepEqual(sends[0].message.gateways, view.gateways);
});

test("a deleted server is no longer offered by the hub", async () => {
	const { plugin, controller } = addressFixture();
	controller.instances.get(2).isDeleted = true;
	const view = await plugin.handleGetGatewayConfigRequest({ instanceId: 1 });
	assert.deepEqual(view.gateways.map(gateway => [gateway.gatewayName, gateway.targets.map(entry => entry.instanceId)]), [
		[ONE_GATE_NAME, [3]],
		["surfexp_gateway_i_3", [3]],
	]);
});

test("gateway pushes and pulls carry passenger carry settings with defaults", async () => {
	const { plugin, config, sends } = addressFixture();
	assert.deepEqual((await plugin.handleGetGatewayConfigRequest({ instanceId: 1 })).passengerCarry, { armor: true, inventory: false });
	await plugin.pushGatewayConfigToInstance(1);
	assert.deepEqual(sends.at(-1).message.passengerCarry, { armor: true, inventory: false });
	assert.deepEqual(sends.at(-1).message.toJSON().passengerCarry, { armor: true, inventory: false });
	config.set("surface_export.passenger_carry_armor", false);
	config.set("surface_export.passenger_carry_inventory", true);
	assert.deepEqual((await plugin.handleGetGatewayConfigRequest({ instanceId: 1 })).passengerCarry, { armor: false, inventory: true });
	await plugin.pushGatewayConfigToAllSources();
	assert.deepEqual(sends.at(-1).message.passengerCarry, { armor: false, inventory: true });
	assert.deepEqual(sends.map(send => send.target), [{ instanceId: 1 }, { instanceId: 1 }, { instanceId: 2 }, { instanceId: 3 }]);
	assert.ok(sends.slice(1).every(send => send.message.passengerCarry.inventory === true), "every server receives the changed setting");
});

function destinationFixture(names) {
	const logger = Object.fromEntries(["info", "warn", "error", "verbose"].map(level => [level, () => {}]));
	const instance = (id, name) => ({ id, gamePort: 34100 + id, config: { get: key => key === "instance.name" ? name : undefined } });
	const controller = {
		config: { get: () => undefined },
		instances: new Map(names.map((name, index) => [index + 1, instance(index + 1, name)])),
		hosts: new Map(),
		async sendTo() { return { success: true }; },
	};
	return { controller, plugin: new GatewayConfig(controller, logger, { isInstanceOnline: () => true, resolveInstanceName: id => names[id - 1] }) };
}

test("each server's hub and destinations lead to every other server by instance id, arriving at its hub", async () => {
	const { plugin } = destinationFixture(["fact1", "fact2", "fact3"]);
	const view = await plugin.handleGetGatewayConfigRequest({ instanceId: 2 });
	assert.deepEqual(view.activeGatewayNames, [ONE_GATE_NAME, "surfexp_gateway_i_1", "surfexp_gateway_i_3"]);
	assert.deepEqual(view.gateways.map(gateway => [gateway.gatewayName, gateway.targets.map(entry => [entry.instanceId, entry.targetGateway])]), [
		[ONE_GATE_NAME, [[1, ONE_GATE_NAME], [3, ONE_GATE_NAME]]],
		["surfexp_gateway_i_1", [[1, ONE_GATE_NAME]]],
		["surfexp_gateway_i_3", [[3, ONE_GATE_NAME]]],
	]);
	const listing = await plugin.handleGetGatewaysRequest({});
	assert.deepEqual(Object.keys(listing), ["destinations"]);
	assert.deepEqual(listing.destinations.map(entry => [entry.gatewayName, entry.instanceName]),
		[["surfexp_gateway_i_1", "fact1"], ["surfexp_gateway_i_2", "fact2"], ["surfexp_gateway_i_3", "fact3"]]);
});

test("a lone server's hub has no destinations", async () => {
	const { plugin } = destinationFixture(["fact1"]);
	const view = await plugin.handleGetGatewayConfigRequest({ instanceId: 1 });
	assert.deepEqual(view.gateways, [{ gatewayName: ONE_GATE_NAME, targets: [] }]);
	assert.deepEqual(view.activeGatewayNames, [ONE_GATE_NAME]);
});

test("every live server is pushed its gateway config and failures are reported per server", async () => {
	const { plugin, controller } = destinationFixture(["fact1", "fact2", "fact3"]);
	controller.instances.get(3).isDeleted = true;
	const pushed = [];
	controller.sendTo = async (target, message) => {
		pushed.push([target.instanceId, message.gateways[0].targets.map(entry => entry.instanceId)]);
		return target.instanceId === 2 ? { success: false, error: "instance 2 unreachable" } : { success: true };
	};
	const results = await plugin.pushGatewayConfigToAllSources();
	assert.deepEqual(pushed, [[1, [2]], [2, [1]]]);
	assert.equal(results.get(1), null);
	assert.equal(results.get(2), "instance 2 unreachable");
	assert.equal(results.has(3), false);
});

test("names do not identify destinations: shared, renamed or unusual names keep their id", async () => {
	const { plugin, controller } = destinationFixture(["fact1", "fact1", "my server!"]);
	assert.deepEqual(plugin.activeGatewayNamesFor(1), [ONE_GATE_NAME, "surfexp_gateway_i_2", "surfexp_gateway_i_3"]);
	controller.instances.get(3).isDeleted = true;
	assert.deepEqual(plugin.activeGatewayNamesFor(1), [ONE_GATE_NAME, "surfexp_gateway_i_2"], "a deleted server has no destination");
});

test("the Discord invite rides the gateway push and pull, trimmed, and an unset invite is sent as empty", async () => {
	const { plugin, config, sends } = addressFixture();
	assert.equal((await plugin.handleGetGatewayConfigRequest({ instanceId: 1 })).discordInvite, "", "an unset invite hides the button");
	config.set("surface_export.discord_invite", "  https://discord.gg/example ");
	assert.equal((await plugin.handleGetGatewayConfigRequest({ instanceId: 1 })).discordInvite, "https://discord.gg/example");
	await plugin.pushGatewayConfigToInstance(1);
	assert.equal(sends.at(-1).message.toJSON().discordInvite, "https://discord.gg/example");
});
