"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Module = require("node:module");
const originalLoad = Module._load;

const registered = [];
class FakeCommand {
	constructor(options) {
		this.definition = options.definition;
		this.handler = options.handler;
		registered.push(this);
	}
}
class FakeCommandTree {
	constructor(options) { this.name = options.name; this.children = []; }
	add(command) { this.children.push(command); }
}
class NoopMetric {
	labels() { return this; }
	inc() {}
	observe() {}
}

Module._load = function patchedLoad(request, parent, isMain) {
	if (request === "@clusterio/lib") {
		return {
			Command: FakeCommand,
			CommandTree: FakeCommandTree,
			escapeString: (value) => String(value),
			safeOutputFile: async (file, data) => fs.writeFileSync(file, data),
			wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
			Counter: NoopMetric,
			Histogram: NoopMetric,
		};
	}
	if (request === "@clusterio/ctl") {
		return { BaseCtlPlugin: class {} };
	}
	return originalLoad.call(this, request, parent, isMain);
};

const distNode = path.join(__dirname, "..", "dist", "node");
const control = require(path.join(distNode, "control.js"));
const messages = require(path.join(distNode, "messages.js"));

const read = registered.find(c => String(c.definition[0]) === "gateways");
const write = registered.find(c => String(c.definition[0]).startsWith("set-gateway-links"));

async function invoke(command, args, reply) {
	const sent = [];
	const printed = [];
	const originalLog = console.log;
	console.log = (line) => printed.push(line);
	try {
		await command.handler(args, { sendTo: async (target, message) => { sent.push({ target, message }); return reply; } });
	} finally {
		console.log = originalLog;
	}
	return { sent, printed };
}

test("gateways reuses GetGatewaysRequest and prints one JSON line", async () => {
	assert.ok(read, "the gateways command must be registered");
	const reply = { gatewayMode: "one_gate", gatewayNames: ["surfexp_gateway_hub"], links: [] };
	const { sent, printed } = await invoke(read, {}, reply);
	assert.equal(sent.length, 1);
	assert.equal(sent[0].target, "controller");
	assert.ok(sent[0].message instanceof messages.GetGatewaysRequest);
	assert.equal(printed.length, 1);
	assert.deepEqual(JSON.parse(printed[0]), reply);
});

test("set-gateway-links sends one SetGatewayLinkRequest with parsed targets", async () => {
	assert.ok(write, "the set-gateway-links command must be registered");
	const { sent, printed } = await invoke(write,
		{ sourceInstanceId: "489642928", gatewayName: "surfexp_gateway_hub", targets: ["280344241", 1329253049, "231718593:surfexp_gateway_2"] },
		{ success: true });
	assert.equal(sent.length, 1);
	assert.ok(sent[0].message instanceof messages.SetGatewayLinkRequest);
	assert.deepEqual(sent[0].message.toJSON(), {
		sourceInstanceId: 489642928,
		gateways: [{ gatewayName: "surfexp_gateway_hub", targets: [
			{ targetInstanceId: 280344241, targetGateway: "surfexp_gateway_hub" },
			{ targetInstanceId: 1329253049, targetGateway: "surfexp_gateway_hub" },
			{ targetInstanceId: 231718593, targetGateway: "surfexp_gateway_2" },
		] }],
	});
	assert.equal(JSON.parse(printed[0]).targets.length, 3);
});

test("no targets clears the gateway, and a refusal fails loudly", async () => {
	const { sent } = await invoke(write, { sourceInstanceId: 1, gatewayName: "surfexp_gateway_hub" }, { success: true });
	assert.deepEqual(sent[0].message.gateways, [{ gatewayName: "surfexp_gateway_hub", targets: [] }]);
	await assert.rejects(() => invoke(write, { sourceInstanceId: 1, gatewayName: "surfexp_gateway_hub", targets: ["2"] },
		{ success: false, error: "Unknown gateway" }), /Unknown gateway/);
});

test("malformed ids are refused before anything is sent", async () => {
	await assert.rejects(() => invoke(write, { sourceInstanceId: "abc", gatewayName: "g", targets: ["2"] }, { success: true }),
		/sourceInstanceId must be an integer/);
	assert.throws(() => control.parseGatewayTargets(["two"], "g"), /target must be <instanceId> or <instanceId>:<gatewayName>/);
	assert.throws(() => control.parseGatewayTargets(["1.5"], "g"), /target must be/);
});
