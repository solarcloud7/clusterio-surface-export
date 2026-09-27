"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
	if (request === "@clusterio/lib") return { Counter: class { labels() { return this; } inc() {} }, Histogram: class { labels() { return this; } observe() {} } };
	return originalLoad.call(this, request, parent, isMain);
};
const { RouteAlertRelay } = require("../dist/node/lib/route-alert-relay");
const messages = require("../dist/node/messages");
Module._load = originalLoad;

function fixture(online = [1, 2, 3]) {
	const sends = [];
	const warnings = [];
	const instance = (id, name) => ({ id, config: { get: key => key === "instance.name" ? name : undefined } });
	const controller = {
		instances: new Map([[1, instance(1, "Forge")], [2, instance(2, "Cinder")], [3, instance(3, "Tide")]]),
		async sendTo(target, message) { sends.push({ target, message }); return { success: true }; },
	};
	const relay = new RouteAlertRelay(controller, { warn: message => warnings.push(message) }, id => online.includes(id));
	return { relay, controller, sends, warnings };
}

const alert = (active = true) => ({ key: "player:5", platformName: "Hauler", forceName: "player", icon: "surfexp_gateway_i_2", active, reason: ["", "cannot reach"] });

test("a route alert is relayed to every other online server with its source name", async () => {
	const { relay, sends } = fixture([1, 2]);
	await relay.accept(1, alert());
	assert.deepEqual(sends.map(send => send.target), [{ instanceId: 2 }], "the source and offline servers are skipped");
	assert.ok(sends[0].message instanceof messages.RelayRouteAlertRequest);
	assert.deepEqual(sends[0].message.toJSON(), { alert: alert(), sourceInstanceId: 1, sourceName: "Forge" });
	assert.equal(relay.activeAlerts().length, 1);
});

test("a cleared alert is relayed and forgotten, and a server that starts later receives only active alerts", async () => {
	const { relay, sends } = fixture([1, 2]);
	await relay.accept(1, alert());
	await relay.accept(2, { ...alert(), key: "player:7" });
	await relay.accept(1, alert(false));
	assert.equal(sends.at(-1).message.alert.active, false);
	assert.deepEqual(relay.activeAlerts().map(entry => entry.sourceInstanceId), [2]);
	sends.length = 0;
	await relay.replayTo(3);
	assert.deepEqual(sends.map(send => [send.target.instanceId, send.message.sourceInstanceId, send.message.alert.key]), [[3, 2, "player:7"]]);
	sends.length = 0;
	await relay.replayTo(2);
	assert.equal(sends.length, 0, "a server is never sent its own alerts");
});

test("a failed or refused delivery is logged without stopping delivery to other servers", async () => {
	const { relay, controller, warnings } = fixture();
	const delivered = [];
	controller.sendTo = async target => {
		if (target.instanceId === 2) throw new Error("connection lost");
		delivered.push(target.instanceId);
		return target.instanceId === 3 ? { success: false, error: "not ready" } : { success: true };
	};
	await relay.accept(1, alert());
	assert.deepEqual(delivered, [3]);
	assert.equal(warnings.length, 2);
	assert.match(warnings.join("\n"), /instance 2 failed: connection lost/);
	assert.match(warnings.join("\n"), /Instance 3 refused the route alert from 1: not ready/);
});
