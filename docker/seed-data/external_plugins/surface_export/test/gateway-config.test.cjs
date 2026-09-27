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

test("a deleted server is no longer offered by the hub and frees its colour", async () => {
	const { plugin, controller } = addressFixture();
	assert.equal((await plugin.handleGetGatewayConfigRequest({ instanceId: 1 })).gateways.length, 3);
	controller.instances.get(2).isDeleted = true;
	const view = await plugin.handleGetGatewayConfigRequest({ instanceId: 1 });
	assert.deepEqual(view.gateways.map(gateway => [gateway.gatewayName, gateway.targets.map(entry => entry.instanceId)]), [
		[ONE_GATE_NAME, [3]],
		["surfexp_gateway_3", [3]],
	], "the remaining server keeps its colour");
	assert.equal(view.ownGatewayName, "surfexp_gateway_1");
	assert.deepEqual(view.activeGatewayNames, [ONE_GATE_NAME, "surfexp_gateway_3"], "a freed colour is locked");
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

function portalFixture(names, slots) {
	const logger = Object.fromEntries(["info", "warn", "error", "verbose"].map(level => [level, () => {}]));
	const instance = (id, name) => ({ id, gamePort: 34100 + id, config: { get: key => key === "instance.name" ? name : undefined } });
	const current = [...names];
	const controller = {
		config: { get: () => undefined },
		instances: new Map(names.map((name, index) => [index + 1, instance(index + 1, name)])),
		hosts: new Map(),
		async sendTo() { return { success: true }; },
	};
	const context = { isInstanceOnline: () => true, resolveInstanceName: id => current[id - 1] ?? null };
	return { controller, current, plugin: new GatewayConfig(controller, logger, context, slots) };
}

test("each other server's colour leads to that server's hub, the Gateway to every other server, and a server's own colour is locked", async () => {
	const { plugin } = portalFixture(["Delta", "Sigma", "Theta"]);
	const view = await plugin.handleGetGatewayConfigRequest({ instanceId: 2 });
	assert.deepEqual(view.activeGatewayNames, [ONE_GATE_NAME, "surfexp_gateway_1", "surfexp_gateway_3"]);
	assert.equal(view.ownGatewayName, "surfexp_gateway_2");
	assert.deepEqual(view.gateways.map(gateway => [gateway.gatewayName, gateway.targets.map(entry => [entry.instanceId, entry.targetGateway])]), [
		[ONE_GATE_NAME, [[1, ONE_GATE_NAME], [3, ONE_GATE_NAME]]],
		["surfexp_gateway_1", [[1, ONE_GATE_NAME]]],
		["surfexp_gateway_3", [[3, ONE_GATE_NAME]]],
	]);
	assert.deepEqual(await plugin.handleGetGatewaysRequest({}), {
		portals: [
			{ slot: 1, colour: "blue", gatewayName: "surfexp_gateway_1", instanceId: 1, instanceName: "Delta" },
			{ slot: 2, colour: "green", gatewayName: "surfexp_gateway_2", instanceId: 2, instanceName: "Sigma" },
			{ slot: 3, colour: "orange", gatewayName: "surfexp_gateway_3", instanceId: 3, instanceName: "Theta" },
		],
		unassigned: [],
		retired: [],
	});
	assert.deepEqual(plugin.portalOf(3), { slot: 3, colour: "orange", label: "Theta" });
});

test("a lone server's Gateway and portals lead nowhere", async () => {
	const { plugin } = portalFixture(["fact1"]);
	const view = await plugin.handleGetGatewayConfigRequest({ instanceId: 1 });
	assert.deepEqual(view.gateways, [{ gatewayName: ONE_GATE_NAME, targets: [] }]);
	assert.deepEqual(view.activeGatewayNames, [ONE_GATE_NAME]);
	assert.equal(view.ownGatewayName, "surfexp_gateway_1");
});

test("every live server is pushed its gateway config and failures are reported per server", async () => {
	const { plugin, controller } = portalFixture(["fact1", "fact2", "fact3"]);
	controller.instances.get(3).isDeleted = true;
	const pushed = [];
	controller.sendTo = async (target, message) => {
		pushed.push([target.instanceId, message.gateways[0].targets.map(entry => entry.instanceId), message.toJSON().ownGatewayName]);
		return target.instanceId === 2 ? { success: false, error: "instance 2 unreachable" } : { success: true };
	};
	const results = await plugin.pushGatewayConfigToAllSources();
	assert.deepEqual(pushed, [[1, [2], "surfexp_gateway_1"], [2, [1], "surfexp_gateway_2"]]);
	assert.equal(results.get(1), null);
	assert.equal(results.get(2), "instance 2 unreachable");
	assert.equal(results.has(3), false);
});

test("names do not identify portals: shared, renamed or unusual names keep their colour", async () => {
	const { plugin, controller, current } = portalFixture(["fact1", "fact1", "my server!"]);
	assert.deepEqual(plugin.activeGatewayNamesFor(1), [ONE_GATE_NAME, "surfexp_gateway_2", "surfexp_gateway_3"]);
	current[2] = "Renamed";
	assert.deepEqual(plugin.portalOf(3), { slot: 3, colour: "orange", label: "Renamed" }, "a rename keeps the colour and shows the new name");
	assert.equal((await plugin.handleGetGatewayConfigRequest({ instanceId: 1 })).gateways[2].targets[0].instanceName, "Renamed");
	controller.instances.get(3).isDeleted = true;
	assert.deepEqual(plugin.activeGatewayNamesFor(1), [ONE_GATE_NAME, "surfexp_gateway_2"], "a deleted server has no portal");
});

test("at most four servers hold a colour; a fifth is reported and does not take a colour freed by a deletion", async () => {
	const { plugin, controller } = portalFixture(["a", "b", "c", "d", "e"]);
	assert.deepEqual(plugin.activeGatewayNamesFor(1), [ONE_GATE_NAME, "surfexp_gateway_2", "surfexp_gateway_3", "surfexp_gateway_4"],
		"no colour leads to the fifth server");
	const fifth = await plugin.handleGetGatewayConfigRequest({ instanceId: 5 });
	assert.equal(fifth.ownGatewayName, undefined);
	assert.deepEqual(fifth.activeGatewayNames, [ONE_GATE_NAME, "surfexp_gateway_1", "surfexp_gateway_2", "surfexp_gateway_3", "surfexp_gateway_4"],
		"the fifth server can still travel to the four others");
	assert.deepEqual(fifth.gateways[0].targets.map(entry => entry.instanceId), [1, 2, 3, 4]);
	assert.deepEqual((await plugin.handleGetGatewaysRequest({})).unassigned, [{ instanceId: 5, instanceName: "e" }]);
	assert.equal(plugin.portalOf(5), null);
	assert.deepEqual((await plugin.handleGetGatewayConfigRequest({ instanceId: 1 })).gateways[0].targets.map(entry => entry.instanceId), [2, 3, 4, 5],
		"the Gateway still reaches a server without a colour");
	controller.instances.delete(2);
	assert.equal(plugin.portalOf(5), null, "a colour freed by deleting its holder is retired, not reassigned");
	assert.deepEqual(plugin.portalOf(3), { slot: 3, colour: "orange", label: "c" }, "other servers keep their colours");
	const listing = await plugin.handleGetGatewaysRequest({});
	assert.deepEqual(listing.unassigned, [{ instanceId: 5, instanceName: "e" }], "the waiting server is still reported");
	assert.deepEqual(listing.retired, [{ slot: 2, colour: "green", gatewayName: "surfexp_gateway_2", formerInstanceId: 2, formerInstanceName: "b" }], "the retired colour names the server it last led to");
	assert.deepEqual(plugin.activeGatewayNamesFor(1), [ONE_GATE_NAME, "surfexp_gateway_3", "surfexp_gateway_4"], "a retired colour is locked everywhere");
});

test("the Discord invite rides the gateway push and pull, trimmed, and an unset invite is sent as empty", async () => {
	const { plugin, config, sends } = addressFixture();
	assert.equal((await plugin.handleGetGatewayConfigRequest({ instanceId: 1 })).discordInvite, "", "an unset invite hides the button");
	config.set("surface_export.discord_invite", "  https://discord.gg/example ");
	assert.equal((await plugin.handleGetGatewayConfigRequest({ instanceId: 1 })).discordInvite, "https://discord.gg/example");
	await plugin.pushGatewayConfigToInstance(1);
	assert.equal(sends.at(-1).message.toJSON().discordInvite, "https://discord.gg/example");
});
