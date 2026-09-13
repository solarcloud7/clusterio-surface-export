"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { ControllerPlugin } = require("../dist/node/controller");
const messages = require("../dist/node/messages");

async function fixture(t) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-handlers-"));
	const handlers = new Map(), warnings = [], sends = [];
	const config = new Map([["controller.database_directory", dir], ["surface_export.gateway_mode", "one_gate"]]);
	const plugin = Object.create(ControllerPlugin.prototype);
	Object.assign(plugin, {
		logger: { info() {}, verbose() {}, warn: x => warnings.push(x), error: x => warnings.push(x) },
		recoveryReservations: new Map(),
		controller: {
			config: {get: key => config.get(key)},
			instances: new Map([1, 2].map(id => [id, {id, status: "running", config: {get: () => 1}}])),
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

const update = () => ({sourceInstanceId: 1,
	gateways: [{gatewayName: messages.ONE_GATE_NAME, targets: [{targetInstanceId: 2, targetGateway: messages.ONE_GATE_NAME}]}]});

test("registered gateway handlers persist, reload and resolve recovery-aware availability", async t => {
	const {plugin, sends, dir, call} = await fixture(t);
	assert.deepEqual(await call(messages.SetGatewayLinkRequest, update()), {success: true});
	assert.equal(sends.length, 1);
	assert.ok(sends[0].message instanceof messages.PushGatewayConfigRequest);
	assert.deepEqual(sends[0].target, {instanceId: 1});
	const stored = await fs.readFile(path.join(dir, "surface_export_gateways.json"), "utf8");
	assert.deepEqual(JSON.parse(stored), [[`1:${messages.ONE_GATE_NAME}`, update().gateways[0].targets]]);
	plugin.recoveryReservations.set(2, {});
	const view = await call(messages.GetGatewayConfigRequest, {instanceId: 1});
	assert.deepEqual(view.gateways[0].targets, [{instanceId: 2, instanceName: "Destination",
		targetGateway: messages.ONE_GATE_NAME, online: false}]);
	assert.deepEqual(view.activeGatewayNames, [messages.ONE_GATE_NAME]);
	plugin.recoveryReservations.set(1, {});
	assert.equal((await call(messages.SetGatewayLinkRequest, update())).success, true);
	assert.equal(sends.length, 1);
	await plugin.orchestrator.stop();
	clearInterval(plugin.recoveryTimer);
	await plugin.init();
	assert.equal((await call(messages.GetGatewaysRequest, {})).links.length, 1);
});

for (const reply of [undefined, {success: false, error: "rejected"}, new Error("connection lost")]) {
	test(`gateway push ${String(reply?.error || reply)} preserves the saved config`, async t => {
		const {plugin, dir, call} = await fixture(t);
		plugin.controller.sendTo = async () => { if (reply instanceof Error) throw reply; return reply; };
		const result = await call(messages.SetGatewayLinkRequest, update());
		assert.equal(result.success, true);
		assert.match(result.error, /Saved, but instance 1/);
		assert.equal(JSON.parse(await fs.readFile(path.join(dir, "surface_export_gateways.json"))).length, 1);
	});
}

test("gateway mode is read dynamically and a rejected handler does not poison later updates", async t => {
	const {plugin, config, warnings, call} = await fixture(t);
	await call(messages.SetGatewayLinkRequest, update());
	config.set("surface_export.gateway_mode", "multi");
	assert.deepEqual((await call(messages.GetGatewaysRequest, {})).links, []);
	assert.deepEqual((await call(messages.GetGatewayConfigRequest, {instanceId: 1})).activeGatewayNames, messages.MULTI_GATEWAY_NAMES);
	config.set("surface_export.gateway_mode", "invalid");
	await call(messages.GetGatewaysRequest, {});
	await call(messages.GetGatewaysRequest, {});
	assert.equal(warnings.length, 1);
	const get = plugin.controller.config.get;
	plugin.controller.config.get = () => { throw Error("config unavailable"); };
	await assert.rejects(call(messages.SetGatewayLinkRequest, update()), /config unavailable/);
	plugin.controller.config.get = get;
	config.set("surface_export.gateway_mode", "one_gate");
	assert.equal((await call(messages.SetGatewayLinkRequest, update())).success, true);
});
