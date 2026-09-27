"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const source = fs.readFileSync(path.join(__dirname, "../web/gateway/gateway-graph.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
const graph = {};
const sharedModules = {
	"../../shared/dto": "../dist/node/shared/dto",
	"../../shared/edge-geometry": "../dist/node/shared/edge-geometry",
	"../../shared/portals": "../dist/node/shared/portals",
};
new Function("require", "exports", compiled.outputText)(id => {
	assert.ok(Object.hasOwn(sharedModules, id), `unexpected import ${id}`);
	return require(sharedModules[id]);
}, graph);

test("refreshing gateway data retains measured dimensions and placement without retaining stale data", () => {
	const previous = [{ id: "one", position: { x: -200, y: 50 }, selected: true,
		measured: { width: 150, height: 150 }, data: { online: false } }];
	const next = [
		{ id: "one", position: { x: 0, y: 0 }, data: { online: true } },
		{ id: "two", position: { x: 300, y: 0 }, data: { online: true } },
	];
	const refreshed = graph.preservePositions(previous, next);
	assert.deepEqual(refreshed[0].measured, { width: 150, height: 150 });
	assert.deepEqual(refreshed[0].position, { x: -200, y: 50 });
	assert.equal(refreshed[0].selected, true);
	assert.equal(refreshed[0].data.online, true);
	assert.strictEqual(refreshed[1], next[1]);
	assert.equal(refreshed[1].measured, undefined);
	assert.equal(next[0].measured, undefined);
});

test("the graph carries a reported auto-pause state into gateway node data", () => {
	const tree = { hosts: [{ hostId: 1, hostName: "host", connected: true, instances: [
		{ instanceId: 1, instanceName: "paused", status: "running", connected: true, autoPause: true },
		{ instanceId: 2, instanceName: "running", status: "running", connected: true },
	] }] };
	const { nodes } = graph.buildGraph(tree);
	assert.deepEqual(nodes.map(node => [node.data.instanceName, node.data.autoPause]), [["paused", true], ["running", false]]);
});

const platform = (platformIndex, platformName, currentTarget, extra = {}) =>
	({ platformIndex, platformName, currentTarget, hasSpaceHub: true, ...extra });

test("gateway nodes carry each server's planets and portal colour", () => {
	const tree = { hosts: [{ hostId: 1, hostName: "host", connected: true, instances: [
		{ instanceId: 1, instanceName: "forge", defaultPlanet: "vulcanus", disabledPlanets: ["gleba"],
			portal: { slot: 3, colour: "orange", label: "forge" } },
		{ instanceId: 2, instanceName: "plain" },
	] }] };
	const { nodes } = graph.buildGraph(tree);
	assert.deepEqual(nodes.map(node => [node.data.defaultPlanet, node.data.disabledPlanets, node.data.portal]), [
		["vulcanus", ["gleba"], { slot: 3, colour: "orange", label: "forge" }],
		["nauvis", [], null],
	]);
});

test("a platform heading for a coloured portal is traffic to the server holding that colour", () => {
	const portal = slot => ({ slot, colour: ["blue", "green", "orange", "purple"][slot - 1], label: "" });
	const tree = { hosts: [{ hostId: 1, hostName: "host", connected: true, instances: [
		{ instanceId: 11, instanceName: "a", portal: portal(1), platforms: [
			platform(1, "one", "surfexp_gateway_2"),
			platform(2, "two", "surfexp_gateway_2"),
			platform(3, "home", "surfexp_gateway_1"),
			platform(4, "unassigned", "surfexp_gateway_4"),
			platform(5, "hub", "surfexp_gateway_hub"),
			platform(6, "planet", "vulcanus"),
			platform(7, "hubless", "surfexp_gateway_2", { hasSpaceHub: false }),
			platform(8, "old", "surfexp_gateway_i_22"),
			platform(9, "third", "surfexp_gateway_3"),
		] },
		{ instanceId: 22, instanceName: "b", portal: portal(2), platforms: [platform(1, "back", "surfexp_gateway_1")] },
		{ instanceId: 33, instanceName: "c", portal: portal(3), platforms: [] },
		{ instanceId: 55, instanceName: "e", portal: null, platforms: [platform(1, "out", "surfexp_gateway_3")] },
	] }] };
	const { routes } = graph.buildGraph(tree);
	assert.deepEqual(routes, [
		{ sourceInstanceId: 11, targetInstanceId: 22, platforms: [
			{ platformIndex: 1, platformName: "one" }, { platformIndex: 2, platformName: "two" }] },
		{ sourceInstanceId: 11, targetInstanceId: 33, platforms: [{ platformIndex: 9, platformName: "third" }] },
		{ sourceInstanceId: 22, targetInstanceId: 11, platforms: [{ platformIndex: 1, platformName: "back" }] },
		{ sourceInstanceId: 55, targetInstanceId: 33, platforms: [{ platformIndex: 1, platformName: "out" }] },
	], "a server's own colour, an unassigned colour, the Gateway and planets make no traffic");
	assert.deepEqual(graph.buildGraph({ hosts: [] }).routes, [], "no servers, no lines");
	const holders = new Map([[1, 11], [2, -3]]);
	assert.equal(graph.headingInstanceId("surfexp_gateway_2", 11, holders), -3, "debug scenarios use negative ids");
	assert.equal(graph.headingInstanceId("surfexp_gateway_1", 11, holders), null, "a server's own colour leads nowhere");
	assert.equal(graph.headingInstanceId("surfexp_gateway_3", 11, holders), null);
	assert.equal(graph.headingInstanceId(null, 11, holders), null);
});

test("traffic is one line per pair of servers, with a direction per side and transfers in flight", () => {
	const routes = [
		{ sourceInstanceId: 22, targetInstanceId: 11, platforms: [] },
		{ sourceInstanceId: 11, targetInstanceId: 22, platforms: [] },
	];
	const ships = [
		{ transferId: "x", sourceInstanceId: 11, targetInstanceId: 33 },
		{ transferId: "y", sourceInstanceId: 22, targetInstanceId: 11 },
		{ transferId: "off-canvas", sourceInstanceId: 11, targetInstanceId: 44 },
	];
	const pairs = graph.groupTraffic(routes, ships, new Set([11, 22, 33]));
	assert.deepEqual(pairs.map(pair => [pair.key, pair.sourceInstanceId, pair.targetInstanceId, pair.forward, pair.reverse,
		pair.routes.length, pair.ships.map(ship => ship.transferId)]), [
		["11|22", 22, 11, true, true, 2, ["y"]],
		["11|33", 11, 33, true, false, 0, ["x"]],
	]);
	assert.deepEqual(graph.groupTraffic([], [], new Set([1, 2])), [], "without traffic there are no lines");
});

test("a server's active planets are the installed planets less its unavailable ones, always including its default", () => {
	const installed = ["aquilo", "fulgora", "gleba", "nauvis", "vulcanus"];
	assert.deepEqual(graph.activePlanets(installed, "nauvis", ["gleba", "aquilo"]), ["fulgora", "nauvis", "vulcanus"]);
	assert.deepEqual(graph.activePlanets(installed, "gleba", ["gleba"]), installed,
		"the default planet is shown even when it is also listed as unavailable");
	assert.deepEqual(graph.activePlanets([], "vulcanus", []), ["vulcanus"], "without prototype data the default planet still shows");
});

test("each server card carries one outgoing portal per other server, spaced like the star map", () => {
	const instances = [
		{ instanceId: 3, instanceName: "Theta", portal: { slot: 3, colour: "orange", label: "Theta" } },
		{ instanceId: 1, instanceName: "Delta", portal: { slot: 1, colour: "blue", label: "Delta" } },
		{ instanceId: 2, instanceName: "Sigma", portal: null },
		{ instanceId: 4, instanceName: "Alpha", portal: { slot: 2, colour: "green", label: "Alpha" } },
	];
	const peers = graph.peerPortalsFor(1, instances);
	assert.deepEqual(peers.map(peer => peer.instanceId), [4, 3, 2], "every other server by colour, a server without one last, never itself");
	assert.deepEqual(peers[1].portal, { slot: 3, colour: "orange", label: "Theta" });
	assert.equal(peers[2].portal, null, "a server without a colour still gets a (grey) portal");
	assert.equal(graph.peerPortalHandleId(3), "portal:3");
	assert.deepEqual([0, 1, 2, 3].map(index => graph.portalOrientation(index, 4)), [0.125, 0.375, 0.625, 0.875],
		"four portals sit on the diagonals, leaving straight up clear, as on the star map");
	const { nodes } = graph.buildGraph({ hosts: [{ hostId: 1, hostName: "h", connected: true, instances }] });
	for (const node of nodes) {
		assert.equal(node.data.peers.length, 3);
		assert.ok(!node.data.peers.some(peer => peer.instanceId === node.data.instanceId));
	}
});

test("outgoing portals face the server they lead to and never overlap", () => {
	const centre = { x: 0, y: 0 };
	assert.equal(graph.facingTurn(centre, { x: 0, y: -10 }), 0, "straight up");
	assert.equal(graph.facingTurn(centre, { x: 10, y: 0 }), 0.25, "to the right");
	assert.equal(graph.facingTurn(centre, { x: 0, y: 10 }), 0.5, "straight down");
	assert.equal(graph.facingTurn(centre, { x: -10, y: 0 }), 0.75, "to the left");
	const spread = graph.spreadTurns([0.25, 0.26, 0.5]);
	assert.ok(spread[1] - spread[0] >= graph.MIN_PORTAL_GAP - 1e-9, "two peers in the same direction are pushed apart");
	assert.ok(Math.abs(spread[2] - 0.5) < 1e-9, "a portal with room keeps its heading");
	assert.deepEqual(graph.spreadTurns([0.3, 0.6]), [0.3, 0.6], "well-separated portals are untouched");
	assert.deepEqual(graph.spreadTurns([0]), [graph.CAPTION_CLEAR_TURN], "a server straight above gets a portal clear of the title");
	assert.deepEqual(graph.spreadTurns([0.97]), [1 - graph.CAPTION_CLEAR_TURN], "leaning left, it swings to the left of the title");
	const crowded = graph.spreadTurns([0.02, 0.05, 0.1]);
	for (const turn of crowded) {
		assert.ok(turn >= graph.CAPTION_CLEAR_TURN - 1e-9 && turn <= 1 - graph.CAPTION_CLEAR_TURN + 1e-9, `turn ${turn} is over the title`);
	}
	const sorted = [...crowded].sort((a, b) => a - b);
	for (let i = 1; i < sorted.length; i += 1) {
		assert.ok(sorted[i] - sorted[i - 1] >= graph.MIN_PORTAL_GAP - 1e-9, "portals pushed off the title still never overlap");
	}
});
