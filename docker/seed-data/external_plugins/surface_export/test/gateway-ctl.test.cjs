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

async function invoke(command, args, reply, sent = []) {
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
	const reply = { portals: [{ slot: 2, colour: "green", gatewayName: "surfexp_gateway_2", instanceId: 2, instanceName: "fact2" }], unassigned: [{ instanceId: 5, instanceName: "fact5" }] };
	const { sent, printed } = await invoke(read, {}, reply);
	assert.equal(sent.length, 1);
	assert.equal(sent[0].target, "controller");
	assert.ok(sent[0].message instanceof messages.GetGatewaysRequest);
	assert.equal(printed.length, 1);
	assert.deepEqual(JSON.parse(printed[0]), reply);
});

test("gateway links cannot be written from the command line", () => {
	assert.equal(registered.some(c => String(c.definition[0]).startsWith("set-gateway-links")), false);
	assert.equal(messages.SetGatewayLinkRequest, undefined);
	assert.equal(control.parseGatewayTargets, undefined);
});
