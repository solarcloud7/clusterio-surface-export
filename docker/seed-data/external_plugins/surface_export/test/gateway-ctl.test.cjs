"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const lib = require("@clusterio/lib");
const { CtlHooks } = require("@clusterio/ctl");
const { commandsOf, registeredCommands } = require("./ctl-harness.cjs");

const distNode = path.join(__dirname, "..", "dist", "node");
const control = require(path.join(distNode, "control.js"));
const messages = require(path.join(distNode, "messages.js"));
const registered = registeredCommands();

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

test("the ctl entrypoint attaches the command tree to the addCommands hook under the plugin name", async () => {
	const quiet = { info() {}, verbose() {}, warn() {}, error() {} };
	const hooks = new CtlHooks(quiet);
	await control.default({ hooks, plugin: { name: "surface_export" }, logger: quiet });
	assert.deepEqual([...hooks.addCommands.attached], ["surface_export"]);
	const root = new lib.CommandTree({ name: "root", description: "clusterioctl" });
	await hooks.addCommands.invoke(root);
	assert.ok(root.subCommands.get("surface-export") instanceof lib.CommandTree, "the hook adds the surface-export tree");
	assert.ok(commandsOf(root).some(command => command.name === "gateways"));
});

test("gateway links cannot be written from the command line", () => {
	assert.equal(registered.some(c => String(c.definition[0]).startsWith("set-gateway-links")), false);
	assert.equal(messages.SetGatewayLinkRequest, undefined);
	assert.equal(control.parseGatewayTargets, undefined);
});

test("portal assign and release send the administrator's request unchanged and print the listing", async () => {
	const assign = registered.find(c => String(c.definition[0]) === "assign <instance> <portal>");
	const release = registered.find(c => String(c.definition[0]) === "release <portal>");
	assert.ok(assign && release, "the portal commands must be registered");
	const reply = { portals: [], unassigned: [], retired: [] };
	const { sent, printed } = await invoke(assign, { instance: 7, portal: "Green" }, reply);
	assert.ok(sent[0].message instanceof messages.SetPortalRequest);
	assert.deepEqual(sent[0].message.toJSON(), { action: "assign", portal: "Green", instance: "7" });
	assert.deepEqual(JSON.parse(printed[0]), reply);
	const released = await invoke(release, { portal: 2 }, reply);
	assert.deepEqual(JSON.parse(JSON.stringify(released.sent[0].message)), { action: "release", portal: "2" });
});
