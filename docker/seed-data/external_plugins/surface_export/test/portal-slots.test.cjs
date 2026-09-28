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
	await first.settle([7, 9]);
	await first.settle([9, 7]);
	assert.equal(writes, 1, "an unchanged assignment is not rewritten");
	assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { version: 1, slots: [[1, 7], [2, 9]], released: [] });

	const restarted = new PortalSlots(recorder().logger);
	await restarted.load(file);
	assert.deepEqual(restarted.assignments(), [{ slot: 1, instanceId: 7 }, { slot: 2, instanceId: 9 }]);
	await restarted.settle([9, 12]);
	assert.deepEqual(restarted.assignments(), [{ slot: 2, instanceId: 9 }, { slot: 3, instanceId: 12 }],
		"a new server takes a never-held colour; the retired colour stays unassigned; the others keep theirs");
	assert.deepEqual(restarted.retired(), [{ slot: 1, previousInstanceId: 7 }]);
	assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { version: 1, slots: [[2, 9], [3, 12]], released: [[1, 7]] });
	const reloaded = new PortalSlots(recorder().logger);
	await reloaded.load(file);
	await reloaded.settle([9, 12, 13, 14]);
	assert.deepEqual(reloaded.assignments(), [{ slot: 2, instanceId: 9 }, { slot: 3, instanceId: 12 }, { slot: 4, instanceId: 13 }],
		"a retired colour stays retired across a reload");
	assert.deepEqual(reloaded.unassigned([9, 12, 13, 14]), [14]);
});

async function committedFile(t, saved) {
	const file = await tempFile(t);
	await fs.writeFile(file, JSON.stringify(saved));
	const { lines, logger } = recorder();
	const slots = new PortalSlots(logger);
	await slots.load(file);
	return { file, lines, slots };
}

async function withFailingWrites(action) {
	failWrites = true;
	try {
		return await action();
	} finally {
		failWrites = false;
	}
}

test("a release that cannot be saved is not applied, and a restart never shows a destination nobody committed", async t => {
	const committed = { version: 1, slots: [[1, 10], [2, 20]], released: [] };
	const { file, lines, slots } = await committedFile(t, committed);
	await withFailingWrites(async () => {
		await assert.rejects(slots.release(1), /could not be saved, so it was not applied/);
		await slots.settle([10, 20]);
		await slots.settle([10, 20]);
	});
	assert.deepEqual(slots.assignments(), [{ slot: 1, instanceId: 10 }, { slot: 2, instanceId: 20 }],
		"the advertised state stays the last saved one: Blue still leads to 10 and no colour moves");
	assert.deepEqual(slots.retired(), []);
	assert.equal(slots.slotOf(10), 1, "the released server never appears on another colour");
	assert.equal(lines.error.filter(line => /disk full/.test(line)).length, 1, "a repeated write failure is logged once");
	assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), committed);
	const restarted = new PortalSlots(recorder().logger);
	await restarted.load(file);
	await restarted.settle([10, 20, 30]);
	assert.deepEqual(restarted.assignments(), [{ slot: 1, instanceId: 10 }, { slot: 2, instanceId: 20 }, { slot: 3, instanceId: 30 }],
		"after the restart the new server takes a colour no other server was ever shown holding");
	assert.deepEqual(await slots.release(1), 10, "once writes succeed the administrator's release applies");
	assert.deepEqual(slots.retired(), [{ slot: 1, previousInstanceId: 10 }]);
});

test("an assignment that cannot be saved is not applied", async t => {
	const committed = { version: 1, slots: [[1, 10]], released: [[2, 20]] };
	const { file, slots } = await committedFile(t, committed);
	await withFailingWrites(() => assert.rejects(slots.assign(2, 10), /could not be saved/));
	assert.deepEqual([slots.assignments(), slots.retired()], [[{ slot: 1, instanceId: 10 }], [{ slot: 2, previousInstanceId: 20 }]]);
	assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), committed);
	assert.deepEqual(await slots.assign(2, 10), [{ slot: 2, previousInstanceId: 20, instanceId: 10 }]);
	assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { version: 1, slots: [[2, 10]], released: [[1, 10]] });
});

test("an automatic assignment or retirement that cannot be saved is neither advertised nor pushed, and applies once saving works", async t => {
	const committed = { version: 1, slots: [[1, 10]], released: [] };
	const { file, slots } = await committedFile(t, committed);
	const controller = { config: { get: () => undefined }, hosts: new Map(), pushed: [],
		instances: new Map([[20, { id: 20, config: { get: () => undefined } }], [30, { id: 30, config: { get: () => undefined } }]]),
		async sendTo(target, message) { this.pushed.push([target.instanceId, message.toJSON().ownGatewayName, message.toJSON().activeGatewayNames]); return { success: true }; } };
	const gateways = new GatewayConfig(controller, recorder().logger, { isInstanceOnline: () => true, resolveInstanceName: id => `s${id}` }, slots);
	await withFailingWrites(async () => {
		await gateways.pushGatewayConfigToAllSources();
		assert.deepEqual(slots.assignments(), [{ slot: 1, instanceId: 10 }], "the unsaved retirement and assignments are not in effect");
		assert.deepEqual(controller.pushed, [[20, undefined, [ONE_GATE_NAME]], [30, undefined, [ONE_GATE_NAME]]],
			"no server is told about a colour that was not saved, and the deleted holder is no destination");
		assert.deepEqual((await gateways.handleGetGatewaysRequest({})).portals, []);
		await slots.flush();
	});
	assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), committed);
	await gateways.pushGatewayConfigToAllSources();
	assert.deepEqual(slots.assignments(), [{ slot: 2, instanceId: 20 }, { slot: 3, instanceId: 30 }]);
	assert.deepEqual(slots.retired(), [{ slot: 1, previousInstanceId: 10 }], "the deleted holder's colour is retired, not reused");
	assert.deepEqual(controller.pushed.slice(2).map(entry => entry.slice(0, 2)), [[20, "surfexp_gateway_2"], [30, "surfexp_gateway_3"]]);
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

test("an administrator assigns and releases colours; a new holder of a retired colour is reported", async t => {
	const file = await tempFile(t);
	const slots = new PortalSlots(recorder().logger);
	await slots.load(file);
	await slots.settle([1, 2]);
	await slots.settle([1]);
	assert.deepEqual(slots.retired(), [{ slot: 2, previousInstanceId: 2 }]);
	await slots.settle([1, 7]);
	assert.equal(slots.slotOf(7), 3, "a new server skips the retired colour");
	assert.deepEqual(await slots.assign(2, 7), [{ slot: 2, previousInstanceId: 2, instanceId: 7 }], "taking a retired colour names its former holder");
	assert.deepEqual(slots.retired(), [{ slot: 3, previousInstanceId: 7 }], "a server moving colour retires the one it left");
	assert.deepEqual(await slots.assign(2, 7), [], "assigning the same colour again changes nothing");
	await assert.rejects(slots.assign(1, 7), /the blue portal is held by instance 1; release it first/);
	assert.equal(await slots.release(1), 1);
	await assert.rejects(slots.release(1), /the blue portal is not held by any server/);
	await slots.settle([1, 7]);
	assert.equal(slots.slotOf(1), 4, "a released server may take a never-held colour");
	assert.deepEqual(slots.retired(), [{ slot: 1, previousInstanceId: 1 }, { slot: 3, previousInstanceId: 7 }]);
	await slots.flush();
	const reloaded = new PortalSlots(recorder().logger);
	await reloaded.load(file);
	assert.deepEqual([reloaded.assignments(), reloaded.retired()], [slots.assignments(), slots.retired()], "admin changes are saved");
	assert.deepEqual([...assignPortalSlots(new Map(), [5, 6], new Set([1]))], [[2, 5], [3, 6]]);
});

test("admin changes are refused while the assignment file is unreadable", async t => {
	const file = await tempFile(t);
	await fs.writeFile(file, "not json");
	const slots = new PortalSlots(recorder().logger);
	await slots.load(file);
	await assert.rejects(slots.assign(1, 7), /stays locked/);
	await assert.rejects(slots.release(1), /stays locked/);
	assert.equal(await fs.readFile(file, "utf8"), "not json");
});

test("an admin change that cannot be saved is reported to the command", async t => {
	const file = await tempFile(t);
	const slots = new PortalSlots(recorder().logger);
	await slots.load(file);
	await slots.settle([1, 2]);
	failWrites = true;
	try {
		await assert.rejects(slots.release(2), /could not be saved/);
	} finally {
		failWrites = false;
	}
});

function adminFixture(entries) {
	const { lines, logger } = recorder();
	const instances = new Map(entries.map(([id, , loaded]) => [id, { id, config: { get: key => key === "surface_export.load_plugin" ? loaded : undefined } }]));
	const names = Object.fromEntries(entries.map(([id, name]) => [id, name]));
	const pushed = [];
	const gateways = new GatewayConfig({ config: { get: () => undefined }, hosts: new Map(), instances,
		async sendTo(target, message) { pushed.push([target.instanceId, message.toJSON().activeGatewayNames]); return { success: true }; } },
	logger, { isInstanceOnline: () => true, resolveInstanceName: id => names[id] ?? null });
	return { lines, instances, names, gateways, pushed };
}

test("the portal command assigns by colour or number and by name or id, pushes every server and warns about a new holder", async () => {
	const { lines, instances, names, gateways, pushed } = adminFixture([[1, "Delta"], [2, "Sigma"], [3, "Theta"]]);
	gateways.activeGatewayNamesFor(1);
	instances.get(2).isDeleted = true;
	gateways.activeGatewayNamesFor(1);
	assert.equal(lines.warn.length, 0, "a deletion alone retires the colour quietly");
	instances.set(4, { id: 4, config: { get: () => undefined } });
	names[4] = "Omega";
	assert.equal(gateways.portalOf(4).slot, 4, "a new server takes a never-held colour");
	const listing = await gateways.handleSetPortalRequest({ action: "assign", portal: "Green", instance: "Theta" });
	assert.match(lines.warn.join("\n"), /The Green portal now leads to Theta \(instance 3\) instead of Sigma \(instance 2\)/);
	assert.deepEqual(listing.portals.map(portal => [portal.slot, portal.instanceId]), [[1, 1], [2, 3], [4, 4]]);
	assert.deepEqual(listing.retired.map(portal => [portal.slot, portal.formerInstanceId]), [[3, 3]]);
	assert.deepEqual(pushed.map(([id]) => id), [1, 3, 4], "every server is pushed the new assignment");
	assert.deepEqual(pushed[0][1], ["surfexp_gateway_hub", "surfexp_gateway_2", "surfexp_gateway_4"]);
	await gateways.handleSetPortalRequest({ action: "release", portal: "2" });
	assert.match(lines.warn.join(" | "), /The Green portal no longer leads to Theta \(instance 3\); it stays locked/);
	await gateways.handleSetPortalRequest({ action: "assign", portal: "3", instance: "3" });
	assert.equal(gateways.portalOf(3).slot, 3);
});

test("the portal command refuses unknown portals and servers, held colours and servers without the plugin", async () => {
	const { gateways } = adminFixture([[1, "Delta"], [2, "Twin"], [3, "Twin"], [4, "Off", false]]);
	gateways.activeGatewayNamesFor(1);
	for (const [request, reason] of [
		[{ action: "assign", portal: "5", instance: "1" }, /Unknown portal '5': use 1-4 or blue, green, orange, purple/],
		[{ action: "assign", portal: "0", instance: "1" }, /Unknown portal/],
		[{ action: "assign", portal: "red", instance: "1" }, /Unknown portal/],
		[{ action: "release", portal: "gateway" }, /Unknown portal/],
		[{ action: "assign", portal: "4", instance: "Ghost" }, /Unknown instance 'Ghost'/],
		[{ action: "assign", portal: "4", instance: "99" }, /Unknown instance '99'/],
		[{ action: "assign", portal: "4", instance: "Twin" }, /shared by several instances/],
		[{ action: "assign", portal: "4", instance: "Off" }, /does not load the surface_export plugin/],
		[{ action: "assign", portal: "blue", instance: "2" }, /the blue portal is held by instance 1; release it first/],
		[{ action: "release", portal: "purple" }, /the purple portal is not held by any server/],
		[{ action: "assign", portal: "4" }, /assign needs an instance/],
	]) {
		await assert.rejects(gateways.handleSetPortalRequest(request), reason, JSON.stringify(request));
	}
	assert.deepEqual(gateways.portals().portals.map(portal => [portal.slot, portal.instanceId]), [[1, 1], [2, 2], [3, 3]], "a refusal changes nothing");
});

test("changing portals needs the transfer administration permission", () => {
	const messages = require("../dist/node/messages");
	assert.equal(messages.SetPortalRequest.permission, messages.PERMISSIONS.TRANSFER_EXPORTS);
	assert.equal(messages.SetPortalRequest.src, "control");
	assert.equal(messages.SetPortalRequest.dst, "controller");
	assert.deepEqual(JSON.parse(JSON.stringify(new messages.SetPortalRequest({ action: "release", portal: "blue" }))), { action: "release", portal: "blue" });
	assert.deepEqual(messages.SetPortalRequest.jsonSchema.properties.action, { enum: ["assign", "release"] });
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
