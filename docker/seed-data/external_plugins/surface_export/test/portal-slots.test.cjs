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
	assert.equal(first.reconcile([7, 9]), true);
	await first.flush();
	assert.equal(first.reconcile([9, 7]), false, "an unchanged assignment is not rewritten");
	await first.flush();
	assert.equal(writes, 1);
	assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { version: 1, slots: [[1, 7], [2, 9]] });

	const restarted = new PortalSlots(recorder().logger);
	await restarted.load(file);
	assert.deepEqual(restarted.assignments(), [{ slot: 1, instanceId: 7 }, { slot: 2, instanceId: 9 }]);
	restarted.reconcile([9, 12]);
	await restarted.flush();
	assert.deepEqual(restarted.assignments(), [{ slot: 1, instanceId: 12 }, { slot: 2, instanceId: 9 }],
		"a deleted server frees its colour for the next new server; the others keep theirs");
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
