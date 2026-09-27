"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { ControllerPlugin } = require("../dist/node/controller");
const messages = require("../dist/node/messages");

async function fixture(t, prepare = async () => {}) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-handlers-"));
	await prepare(dir);
	const handlers = new Map(), warnings = [], sends = [];
	const config = new Map([["controller.database_directory", dir]]);
	const plugin = Object.create(ControllerPlugin.prototype);
	Object.assign(plugin, {
		logger: { info() {}, verbose() {}, warn: x => warnings.push(x), error: x => warnings.push(x) },
		recoveryReservations: new Map(),
		controller: {
			config: {get: key => config.get(key)},
			instances: new Map([1, 2].map(id => [id, {id, status: "running", config: {get: key => key === "instance.name" ? `fact${id}` : 1}}])),
			hosts: new Map([[1, {connected: true}]]),
			handle: (type, handler) => handlers.set(type, handler),
			async sendTo(target, message) {
				assert.equal(this, plugin.controller);
				sends.push({target, message});
				return {success: true};
			},
		},
	});
	t.after(async () => {
		plugin.orchestrator?.stop();
		clearInterval(plugin.recoveryTimer);
		plugin.subscriptions?.treeBroadcastLimiter.cancel();
		await fs.rm(dir, {recursive: true, force: true});
	});
	await plugin.init();
	plugin.platformTree.resolveInstanceName = id => id === 2 ? "Destination" : null;
	return {plugin, config, warnings, sends, dir, call: (type, value) => handlers.get(type)(value)};
}

test("registered gateway handlers lead every server to every other server with recovery-aware availability", async t => {
	const {plugin, call} = await fixture(t);
	assert.equal(messages.SetGatewayLinkRequest, undefined, "gateway links are not configurable");
	plugin.recoveryReservations.set(2, {});
	const view = await call(messages.GetGatewayConfigRequest, {instanceId: 1});
	assert.deepEqual(view.gateways[0], {gatewayName: messages.ONE_GATE_NAME, targets: [{instanceId: 2, instanceName: "Destination",
		targetGateway: messages.ONE_GATE_NAME, online: false, address: ""}]}, "the hub offers every other server");
	assert.deepEqual(view.gateways[1], {gatewayName: "surfexp_gateway_i_2", targets: [{instanceId: 2, instanceName: "Destination",
		targetGateway: messages.ONE_GATE_NAME, online: false, address: ""}]}, "the other server's destination leads to its hub");
	assert.equal(view.gateways.length, 2, "a server has no destination leading to itself");
	assert.deepEqual(view.activeGatewayNames, [messages.ONE_GATE_NAME, "surfexp_gateway_i_2"]);
	assert.deepEqual(view.passengerCarry, {armor: true, inventory: false});
	plugin.recoveryReservations.delete(2);
	const back = await call(messages.GetGatewayConfigRequest, {instanceId: 2});
	assert.deepEqual(back.gateways[0].targets.map(target => [target.instanceId, target.online]), [[1, true]]);
	assert.deepEqual(await call(messages.GetGatewaysRequest, {}), {destinations: [
		{gatewayName: "surfexp_gateway_i_1", instanceId: 1, instanceName: "1"},
		{gatewayName: "surfexp_gateway_i_2", instanceId: 2, instanceName: "Destination"},
	]});
});

test("a gateway link file left by an older version is neither read nor changed", async t => {
	const bytes = JSON.stringify([[`1:${messages.ONE_GATE_NAME}`, []], [`2:${messages.ONE_GATE_NAME}`, [{targetInstanceId: 9, targetGateway: "x"}]]]);
	const {dir, call} = await fixture(t, dir => fs.writeFile(path.join(dir, "surface_export_gateways.json"), bytes));
	const view = await call(messages.GetGatewayConfigRequest, {instanceId: 1});
	assert.deepEqual(view.gateways[0].targets.map(target => target.instanceId), [2], "an emptied stored link does not hide a server");
	assert.deepEqual((await call(messages.GetGatewayConfigRequest, {instanceId: 2})).gateways[0].targets.map(target => target.instanceId), [1]);
	assert.equal(await fs.readFile(path.join(dir, "surface_export_gateways.json"), "utf8"), bytes);
});

for (const reply of [undefined, {success: false, error: "rejected"}, new Error("connection lost")]) {
	test(`gateway push ${String(reply?.error || reply)} is reported per instance`, async t => {
		const {plugin} = await fixture(t);
		plugin.controller.sendTo = async () => { if (reply instanceof Error) throw reply; return reply; };
		const results = await plugin.gatewayConfig.pushGatewayConfigToAllSources();
		assert.deepEqual([...results.keys()], [1, 2]);
		for (const error of results.values()) assert.ok(error, "a failed push names its reason");
	});
}

test("passenger carry setting changes re-push gateway config; other fields do not", async t => {
	const {plugin, warnings} = await fixture(t);
	let pushes = 0;
	plugin.gatewayConfig.pushGatewayConfigToAllSources = async () => {
		pushes++;
		return new Map([[1, null], [2, "instance 2 unreachable"]]);
	};
	await plugin.onControllerConfigFieldChanged("surface_export.passenger_carry_armor", false, true);
	await plugin.onControllerConfigFieldChanged("surface_export.passenger_carry_inventory", true, false);
	await plugin.onControllerConfigFieldChanged("surface_export.platform_source_of_truth", "save_game", "plugin_history");
	assert.equal(pushes, 2);
	assert.equal(warnings.filter(warning => /instance 2 unreachable/.test(warning)).length, 2);
	assert.equal(warnings.some(warning => /instance 1 /.test(warning)), false);
});
