"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const source = fs.readFileSync(path.join(__dirname, "../web/gateway/gateway-graph.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
const graph = {};
const sharedModules = { "../../shared/dto": "../dist/node/shared/dto", "../../shared/edge-geometry": "../dist/node/shared/edge-geometry" };
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
	const { nodes } = graph.buildGraph(tree, {});
	assert.deepEqual(nodes.map(node => [node.data.instanceName, node.data.autoPause]), [["paused", true], ["running", false]]);
});
