"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
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
const { ControllerPlugin } = require("../dist/node/controller");
const { ONE_GATE_NAME, MULTI_GATEWAY_NAMES } = require("../dist/node/messages");
Module._load = originalLoad;

const target = (id, gateway = ONE_GATE_NAME) => ({ targetInstanceId: id, targetGateway: gateway });
const request = (id, targets, gatewayName = ONE_GATE_NAME) => ({
	sourceInstanceId: id, gateways: [{ gatewayName, targets }],
});

async function fixture(t, mode = "one_gate") {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-persistence-"));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const plugin = Object.create(ControllerPlugin.prototype);
	const logs = [];
	const pushes = [];
	plugin.logger = Object.fromEntries(["info", "warn", "error", "verbose"].map(level =>
		[level, message => logs.push({ level, message })]));
	plugin.controller = { instances: new Map([1, 2, 3].map(id => [id, { id }])) };
	plugin.gatewayMode = () => mode;
	plugin.gatewayLinks = new Map();
	plugin.gatewayConfigPath = path.join(directory, "gateways.json");
	plugin.pushGatewayConfigToInstance = async id => {
		pushes.push({ id, links: structuredClone(plugin.gatewayLinks) });
		return null;
	};
	return { plugin, directory, logs, pushes };
}

function pauseNextWrite(plugin, failure = null) {
	const persist = plugin.persistGatewayConfig.bind(plugin);
	let enter;
	let release;
	const entered = new Promise(resolve => { enter = resolve; });
	const released = new Promise(resolve => { release = resolve; });
	let first = true;
	plugin.persistGatewayConfig = async (...args) => {
		if (first) {
			first = false;
			enter();
			await released;
			if (failure) return failure;
		}
		return persist(...args);
	};
	return { entered, release };
}

test("failed gateway writes preserve live routes and do not push settings", async t => {
	const { plugin, directory, pushes } = await fixture(t);
	plugin.gatewayLinks.set(`1:${ONE_GATE_NAME}`, [target(2)]);
	const original = structuredClone(plugin.gatewayLinks);
	plugin.gatewayConfigPath = directory;
	const result = await plugin.handleSetGatewayLinkRequest(request(1, [target(3)]));
	assert.equal(result.success, false);
	assert.match(result.error, /could not be written/);
	assert.deepEqual(plugin.gatewayLinks, original);
	assert.deepEqual(pushes, []);
});

test("gateway edits become visible only after persistence completes", async t => {
	const { plugin, pushes } = await fixture(t);
	const paused = pauseNextWrite(plugin);
	const saving = plugin.handleSetGatewayLinkRequest(request(1, [target(2)]));
	await paused.entered;
	const duringWrite = structuredClone(plugin.gatewayLinks);
	paused.release();
	assert.equal((await saving).success, true);
	assert.equal(duringWrite.size, 0);
	assert.deepEqual(pushes[0].links, plugin.gatewayLinks);
	assert.deepEqual(JSON.parse(await fs.readFile(plugin.gatewayConfigPath, "utf8")), [...plugin.gatewayLinks]);
});

test("a failed overlapping save cannot leak into a later successful save", async t => {
	const { plugin, pushes } = await fixture(t);
	const paused = pauseNextWrite(plugin, "disk full");
	const first = plugin.handleSetGatewayLinkRequest(request(1, [target(2)]));
	await paused.entered;
	const second = plugin.handleSetGatewayLinkRequest(request(2, [target(3)]));
	paused.release();
	assert.equal((await first).success, false);
	assert.equal((await second).success, true);
	assert.deepEqual([...plugin.gatewayLinks], [[`2:${ONE_GATE_NAME}`, [target(3)]]]);
	assert.deepEqual(JSON.parse(await fs.readFile(plugin.gatewayConfigPath, "utf8")), [...plugin.gatewayLinks]);
	assert.deepEqual(pushes.map(push => push.id), [2]);
});

test("overlapping multi-gateway saves validate against committed routes", async t => {
	const { plugin } = await fixture(t, "multi");
	const [one, two] = MULTI_GATEWAY_NAMES;
	const paused = pauseNextWrite(plugin);
	const first = plugin.handleSetGatewayLinkRequest(request(1, [target(2, one)], one));
	await paused.entered;
	const second = plugin.handleSetGatewayLinkRequest(request(1, [target(2, two)], two));
	paused.release();
	assert.equal((await first).success, true);
	const rejected = await second;
	assert.equal(rejected.success, false);
	assert.match(rejected.error, /each destination gets one gateway/);
	assert.deepEqual([...plugin.gatewayLinks], [[`1:${one}`, [target(2, one)]]]);
});

test("overlapping successful saves preserve both instances and push in commit order", async t => {
	const { plugin, pushes } = await fixture(t);
	const paused = pauseNextWrite(plugin);
	const first = plugin.handleSetGatewayLinkRequest(request(1, [target(2)]));
	await paused.entered;
	const second = plugin.handleSetGatewayLinkRequest(request(2, [target(3)]));
	paused.release();
	assert.deepEqual(await Promise.all([first, second]), [{ success: true }, { success: true }]);
	assert.deepEqual([...plugin.gatewayLinks], [
		[`1:${ONE_GATE_NAME}`, [target(2)]], [`2:${ONE_GATE_NAME}`, [target(3)]],
	]);
	assert.deepEqual(pushes.map(push => push.id), [1, 2]);
	assert.deepEqual([...pushes[0].links], [[`1:${ONE_GATE_NAME}`, [target(2)]]]);
	assert.deepEqual(JSON.parse(await fs.readFile(plugin.gatewayConfigPath, "utf8")), [...plugin.gatewayLinks]);
});

test("a failed multi-gateway save does not reserve its destination", async t => {
	const { plugin } = await fixture(t, "multi");
	const [one, two] = MULTI_GATEWAY_NAMES;
	const paused = pauseNextWrite(plugin, "disk full");
	const first = plugin.handleSetGatewayLinkRequest(request(1, [target(2, one)], one));
	await paused.entered;
	const second = plugin.handleSetGatewayLinkRequest(request(1, [target(2, two)], two));
	paused.release();
	assert.equal((await first).success, false);
	assert.equal((await second).success, true);
	assert.deepEqual([...plugin.gatewayLinks], [[`1:${two}`, [target(2, two)]]]);
});

for (const [label, bytes] of [
	["invalid JSON", "{broken"],
	["wrong root shape", "{}"],
	["malformed entry", JSON.stringify([[`1:${ONE_GATE_NAME}`, [target(2)]], null])],
	["invalid target", JSON.stringify([[`1:${ONE_GATE_NAME}`, [null]]])],
]) {
	test(`${label} blocks edits and preserves the original gateway file`, async t => {
		const { plugin, pushes } = await fixture(t);
		await fs.writeFile(plugin.gatewayConfigPath, bytes);
		await plugin.loadGatewayConfig();
		assert.equal(plugin.gatewayLinks.size, 0);
		const result = await plugin.handleSetGatewayLinkRequest(request(1, [target(2)]));
		assert.equal(result.success, false);
		assert.equal(await fs.readFile(plugin.gatewayConfigPath, "utf8"), bytes);
		assert.equal(plugin.gatewayLinks.size, 0);
		assert.deepEqual(pushes, []);
	});
}

test("a missing gateway file allows saves and a fresh load retains inactive layouts", async t => {
	const { plugin } = await fixture(t);
	await plugin.loadGatewayConfig();
	plugin.gatewayLinks.set(`1:${MULTI_GATEWAY_NAMES[0]}`, [target(3, MULTI_GATEWAY_NAMES[0])]);
	assert.equal((await plugin.handleSetGatewayLinkRequest(request(1, [target(2)]))).success, true);
	const expected = structuredClone(plugin.gatewayLinks);
	plugin.gatewayLinks = new Map();
	await plugin.loadGatewayConfig();
	assert.deepEqual(plugin.gatewayLinks, expected);
	assert.equal((await plugin.handleSetGatewayLinkRequest(request(1, []))).success, true);
	assert.equal(plugin.gatewayLinks.has(`1:${ONE_GATE_NAME}`), false);
	assert.equal(plugin.gatewayLinks.has(`1:${MULTI_GATEWAY_NAMES[0]}`), true);
});

test("a push failure reports the durable save and allows a later update", async t => {
	const { plugin } = await fixture(t);
	plugin.pushGatewayConfigToInstance = async () => "instance disconnected";
	const result = await plugin.handleSetGatewayLinkRequest(request(1, [target(2)]));
	assert.equal(result.success, true);
	assert.match(result.error, /Saved, but instance 1/);
	assert.deepEqual(JSON.parse(await fs.readFile(plugin.gatewayConfigPath, "utf8")), [...plugin.gatewayLinks]);
	plugin.pushGatewayConfigToInstance = async () => null;
	assert.equal((await plugin.handleSetGatewayLinkRequest(request(1, [target(3)]))).success, true);
});

test("legacy gateway migration excludes self routes and survives a new load", async t => {
	const { plugin } = await fixture(t);
	const name = MULTI_GATEWAY_NAMES[0];
	await fs.writeFile(plugin.gatewayConfigPath, JSON.stringify([[name, [target(1, name), target(2, name)]]]));
	await plugin.loadGatewayConfig();
	assert.deepEqual(plugin.gatewayLinks.get(`1:${name}`), [target(2, name)]);
	assert.deepEqual(plugin.gatewayLinks.get(`2:${name}`), [target(1, name)]);
	const expected = structuredClone(plugin.gatewayLinks);
	plugin.gatewayLinks = new Map();
	await plugin.loadGatewayConfig();
	assert.deepEqual(plugin.gatewayLinks, expected);
});

test("legacy links remain on disk until instances are available for migration", async t => {
	const { plugin } = await fixture(t);
	plugin.controller.instances.clear();
	const name = MULTI_GATEWAY_NAMES[0];
	const bytes = JSON.stringify([[name, [target(2, name)]]]);
	await fs.writeFile(plugin.gatewayConfigPath, bytes);
	await plugin.loadGatewayConfig();
	assert.deepEqual([...plugin.gatewayLinks], [[name, [target(2, name)]]]);
	assert.equal(await fs.readFile(plugin.gatewayConfigPath, "utf8"), bytes);
	plugin.controller.instances.set(1, { id: 1 });
	await plugin.loadGatewayConfig();
	assert.deepEqual([...plugin.gatewayLinks], [[`1:${name}`, [target(2, name)]]]);
});

test("an unsaved migration reports its failure and keeps the legacy file", async t => {
	const { plugin, logs } = await fixture(t);
	const name = MULTI_GATEWAY_NAMES[0];
	const bytes = JSON.stringify([[name, [target(2, name)]]]);
	await fs.writeFile(plugin.gatewayConfigPath, bytes);
	plugin.persistGatewayConfig = async () => "disk full";
	await plugin.loadGatewayConfig();
	assert.deepEqual(plugin.gatewayLinks.get(`1:${name}`), [target(2, name)]);
	assert.equal(await fs.readFile(plugin.gatewayConfigPath, "utf8"), bytes);
	assert.ok(logs.some(log => /migration.*could not be saved/.test(log.message)));
	assert.ok(!logs.some(log => /^Migrated /.test(log.message)));
});

test("a repaired gateway file can be reloaded after an I/O error", async t => {
	const { plugin } = await fixture(t);
	await fs.mkdir(plugin.gatewayConfigPath);
	await plugin.loadGatewayConfig();
	assert.ok(plugin.gatewayConfigLoadError);
	await fs.rmdir(plugin.gatewayConfigPath);
	const bytes = JSON.stringify([[`1:${ONE_GATE_NAME}`, [target(2)]]]);
	await fs.writeFile(plugin.gatewayConfigPath, bytes);
	assert.equal((await plugin.handleSetGatewayLinkRequest(request(1, [target(3)]))).success, false);
	assert.equal(await fs.readFile(plugin.gatewayConfigPath, "utf8"), bytes);
	await plugin.loadGatewayConfig();
	assert.equal(plugin.gatewayConfigLoadError, null);
	assert.deepEqual(plugin.gatewayLinks.get(`1:${ONE_GATE_NAME}`), [target(2)]);
	assert.equal((await plugin.handleSetGatewayLinkRequest(request(1, [target(3)]))).success, true);
});
