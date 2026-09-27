"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const originalLoad = Module._load;
let writes = 0;
let failWrites = false;
Module._load = function(request, parent, isMain) {
	if (request === "@clusterio/lib") {
		return { safeOutputFile: async (file, data) => {
			writes += 1;
			if (failWrites) throw new Error("disk full");
			await fs.writeFile(file, data);
		} };
	}
	if (request === "@clusterio/controller") return { BaseControllerPlugin: class {} };
	return originalLoad.call(this, request, parent, isMain);
};
const { PortalSlots, assignPortalSlots, PORTAL_SLOTS_FILENAME } = require("../dist/node/lib/portal-slots");
const { GatewayConfig } = require("../dist/node/lib/gateway-config");
const { ONE_GATE_NAME } = require("../dist/node/messages");
const { PORTAL_COLOURS, portalSlotOf, portalGatewayName } = require("../dist/node/shared/portals");
Module._load = originalLoad;

function recorder() {
	const lines = { info: [], warn: [], error: [] };
	return { lines, logger: { info: m => lines.info.push(m), warn: m => lines.warn.push(m), error: m => lines.error.push(m), verbose() {} } };
}

async function tempFile(t) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "portal-slots-"));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	return path.join(dir, PORTAL_SLOTS_FILENAME);
}

test("the colours and portal names match the gateway mod", async () => {
	const modData = await fs.readFile(path.join(__dirname, "../../../mods-src/surfexp_gateways/data.lua"), "utf8");
	const colours = modData.match(/GATEWAY_COLOURS = \{([^}]*)\}/)[1].match(/"([a-z]+)"/g).map(name => name.slice(1, -1));
	assert.deepEqual([...PORTAL_COLOURS], colours);
	assert.ok(modData.includes("local name = \"surfexp_gateway_\" .. i"));
	assert.deepEqual([1, 2, 3, 4].map(portalGatewayName).map(portalSlotOf), [1, 2, 3, 4]);
	for (const name of ["surfexp_gateway_hub", "surfexp_gateway_5", "surfexp_gateway_0", "surfexp_gateway_01", "surfexp_gateway_i_2", null]) {
		assert.equal(portalSlotOf(name), null, String(name));
	}
});

test("existing holders keep their colour; newcomers take the lowest free colour in instance id order", () => {
	assert.deepEqual([...assignPortalSlots(new Map(), [30, 10, 20])], [[1, 10], [2, 20], [3, 30]]);
	assert.deepEqual([...assignPortalSlots(new Map([[1, 30]]), [30, 10, 20])], [[1, 30], [2, 10], [3, 20]], "a restart never reshuffles colours");
	assert.deepEqual([...assignPortalSlots(new Map([[1, 10], [2, 20], [3, 30]]), [10, 30, 40])], [[1, 10], [2, 40], [3, 30]]);
	assert.deepEqual([...assignPortalSlots(new Map(), [1, 2, 3, 4, 5, 6])], [[1, 1], [2, 2], [3, 3], [4, 4]], "at most four colours");
	assert.deepEqual([...assignPortalSlots(new Map([[9, 1], [2, 1], [3, 1]]), [1])], [[2, 1]], "an invalid or duplicate holder is dropped");
});

test("assignments are saved on change and survive a controller restart", async t => {
	const file = await tempFile(t);
	const first = new PortalSlots(recorder().logger);
	await first.load(file);
	writes = 0;
	assert.deepEqual(first.reconcile([7, 9]), []);
	await first.flush();
	first.reconcile([9, 7]);
	await first.flush();
	assert.equal(writes, 1, "an unchanged assignment is not rewritten");
	assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { version: 1, slots: [[1, 7], [2, 9]], released: [] });

	const restarted = new PortalSlots(recorder().logger);
	await restarted.load(file);
	assert.deepEqual(restarted.assignments(), [{ slot: 1, instanceId: 7 }, { slot: 2, instanceId: 9 }]);
	assert.deepEqual(restarted.reconcile([9, 12]), [{ slot: 1, previousInstanceId: 7, instanceId: 12 }], "a deleted holder replaced at once is a change");
	await restarted.flush();
	assert.deepEqual(restarted.assignments(), [{ slot: 1, instanceId: 12 }, { slot: 2, instanceId: 9 }],
		"a deleted server frees its colour for the next new server; the others keep theirs");
	assert.deepEqual(restarted.reconcile([9, 12]), []);
	assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")).slots, [[1, 12], [2, 9]]);
});

test("a failed save is logged and retried on the next reconcile", async t => {
	const file = await tempFile(t);
	const { lines, logger } = recorder();
	const slots = new PortalSlots(logger);
	await slots.load(file);
	failWrites = true;
	slots.reconcile([1]);
	await slots.flush();
	failWrites = false;
	assert.match(lines.error.join("\n"), /could not be saved.*disk full/);
	slots.reconcile([1]);
	await slots.flush();
	assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")).slots, [[1, 1]]);
});

test("a fifth server is reported once while it waits for a colour", async () => {
	const { lines, logger } = recorder();
	const slots = new PortalSlots(logger);
	slots.reconcile([1, 2, 3, 4, 5]);
	slots.reconcile([1, 2, 3, 4, 5]);
	assert.equal(lines.warn.length, 1);
	assert.match(lines.warn[0], /No portal colour for instance\(s\) 5: at most 4 servers/);
	assert.deepEqual(slots.unassigned([1, 2, 3, 4, 5]), [5]);
});

for (const [label, bytes] of [["unreadable", "not json"], ["duplicate", JSON.stringify({ version: 1, slots: [[1, 7], [1, 9]] })],
	["out of range", JSON.stringify({ version: 1, slots: [[5, 7]] })], ["unversioned", JSON.stringify({ slots: [] })]]) {
	test(`an ${label} assignment file locks every coloured portal and is left untouched`, async t => {
		const file = await tempFile(t);
		await fs.writeFile(file, bytes);
		const { lines, logger } = recorder();
		const slots = new PortalSlots(logger);
		await slots.load(file);
		assert.match(slots.loadError, /stays locked/);
		assert.equal(lines.error.length, 1);
		const controller = { config: { get: () => undefined }, hosts: new Map(), async sendTo() { return { success: true }; },
			instances: new Map([[7, { id: 7, config: { get: () => undefined } }], [9, { id: 9, config: { get: () => undefined } }]]) };
		const gateways = new GatewayConfig(controller, logger, { isInstanceOnline: () => true, resolveInstanceName: id => `s${id}` }, slots);
		const view = await gateways.handleGetGatewayConfigRequest({ instanceId: 7 });
		assert.deepEqual(view.activeGatewayNames, [ONE_GATE_NAME], "no portal opens while the assignment is unknown");
		assert.deepEqual(view.gateways, [{ gatewayName: ONE_GATE_NAME, targets: [{ instanceId: 9, instanceName: "s9",
			targetGateway: ONE_GATE_NAME, online: true, address: "" }] }], "the Gateway still reaches every other server");
		assert.equal(view.ownGatewayName, undefined);
		const listing = await gateways.handleGetGatewaysRequest({});
		assert.deepEqual([listing.portals, listing.unassigned], [[], []]);
		assert.equal(listing.error, slots.loadError);
		await slots.flush();
		assert.equal(await fs.readFile(file, "utf8"), bytes);
	});
}

test("a colour that changes holder is reported with its former holder, also across a restart", async t => {
	const file = await tempFile(t);
	const slots = new PortalSlots(recorder().logger);
	await slots.load(file);
	assert.deepEqual(slots.reconcile([1, 2]), [], "first assignments have no former holder");
	assert.deepEqual(slots.reconcile([1]), [], "a freed colour is not yet a change");
	await slots.flush();
	assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { version: 1, slots: [[1, 1]], released: [[2, 2]] });
	const restarted = new PortalSlots(recorder().logger);
	await restarted.load(file);
	assert.deepEqual(restarted.reconcile([1, 7]), [{ slot: 2, previousInstanceId: 2, instanceId: 7 }]);
	assert.deepEqual(restarted.reconcile([1, 7]), [], "a change is reported once");
	await restarted.flush();
	assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")).released, []);
});

test("freed colours can be withheld from new servers with one option", () => {
	const slots = new PortalSlots(recorder().logger, { reuseFreedColours: false });
	slots.reconcile([1, 2, 3]);
	slots.reconcile([1, 3]);
	assert.deepEqual(slots.reconcile([1, 3, 9]), []);
	assert.deepEqual(slots.assignments(), [{ slot: 1, instanceId: 1 }, { slot: 3, instanceId: 3 }, { slot: 4, instanceId: 9 }],
		"the freed Green Gateway stays unassigned; the newcomer takes an unused colour");
	assert.deepEqual([...assignPortalSlots(new Map(), [5, 6], new Set([1]))], [[2, 5], [3, 6]]);
});

test("a colour taking a new holder warns on the controller with the colour and both servers", async () => {
	const { lines, logger } = recorder();
	const instances = new Map([1, 2, 3].map(id => [id, { id, config: { get: () => undefined } }]));
	const names = { 1: "Delta", 2: "Sigma", 3: "Theta", 4: "Omega" };
	const gateways = new GatewayConfig({ config: { get: () => undefined }, hosts: new Map(), instances, async sendTo() { return { success: true }; } },
		logger, { isInstanceOnline: () => true, resolveInstanceName: id => names[id] ?? null });
	gateways.activeGatewayNamesFor(1);
	instances.get(2).isDeleted = true;
	gateways.activeGatewayNamesFor(1);
	assert.equal(lines.warn.length, 0);
	instances.set(4, { id: 4, config: { get: () => undefined } });
	assert.deepEqual(gateways.portalOf(4), { slot: 2, colour: "green", label: "Omega" });
	assert.equal(lines.warn.length, 1);
	assert.match(lines.warn[0], /The Green Gateway now leads to Omega \(instance 4\) instead of Sigma \(instance 2\)/);
});

test("servers without the plugin loaded take no colour and are no destination", async () => {
	const instance = (id, loaded) => ({ id, config: { get: key => key === "surface_export.load_plugin" ? loaded : undefined } });
	const instances = new Map([[1, instance(1, true)], [2, instance(2, false)], [3, instance(3, undefined)]]);
	const sent = [];
	const gateways = new GatewayConfig({ config: { get: () => undefined }, hosts: new Map(), instances,
		async sendTo(target) { sent.push(target.instanceId); return { success: true }; } },
	recorder().logger, { isInstanceOnline: () => true, resolveInstanceName: id => `s${id}` });
	const view = await gateways.handleGetGatewayConfigRequest({ instanceId: 1 });
	assert.deepEqual(view.gateways.map(gateway => [gateway.gatewayName, gateway.targets.map(target => target.instanceId)]),
		[[ONE_GATE_NAME, [3]], ["surfexp_gateway_2", [3]]]);
	assert.equal(gateways.portalOf(2), null);
	assert.deepEqual((await gateways.handleGetGatewaysRequest({})).unassigned, [], "a server without the plugin is not waiting for a colour");
	await gateways.pushGatewayConfigToAllSources();
	assert.deepEqual(sent, [1, 3], "a server without the plugin is not pushed gateway config");
});
