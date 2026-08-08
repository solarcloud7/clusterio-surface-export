"use strict";
const test = require("node:test");
const assert = require("node:assert");

const {
	applyConnect,
	applyDisconnect,
	buildEdges,
	buildGraph,
	dirtyKeys,
	editKey,
	editsFromLinks,
	gatewayFromHandleId,
	gatewayUsage,
	instanceIdFromNodeId,
	instanceNodeId,
	parseEditKey,
	preservePositions,
	sourceHandleId,
	targetHandleId,
} = require("../dist/node/shared/gateway-graph.js");

/**
 * The canvas replaces a form grid, and the whole reason it can is that gateway config IS a graph.
 * These tests pin the projection both ways — config -> edges, and edge gestures -> config — because
 * this repo has no React test harness (npm test is bare `node --test`, and eslint ignores web/**),
 * so this pure module is the only part of the feature that can be covered mechanically.
 *
 * Shapes are production-shaped: instance ids are the real 9-10 digit controller ids from this
 * cluster, not 1/2, because id formatting is exactly the sort of thing a toy fixture hides.
 */
const HOST_1_INSTANCE = 472806668;
const HOST_2_INSTANCE = 1285554351;

const GW1 = "surfexp_gateway_1";
const GW3 = "surfexp_gateway_3";

const TREE = {
	hosts: [
		{
			hostId: 1,
			hostName: "clusterio-host-1",
			connected: true,
			instances: [{
				instanceId: HOST_1_INSTANCE,
				instanceName: "clusterio-host-1-instance-1",
				gamePort: 34100,
				status: "running",
				connected: true,
			}],
		},
		{
			hostId: 2,
			hostName: "clusterio-host-2",
			connected: true,
			instances: [{
				instanceId: HOST_2_INSTANCE,
				instanceName: "clusterio-host-2-instance-1",
				gamePort: 34200,
				status: "running",
				connected: true,
			}],
		},
	],
	unassignedInstances: [],
};

// ── The direction property: the reason edges carry forward/reverse at all ────

test("a symmetric pair of links renders as ONE edge, arrowed at both ends", () => {
	const edits = {
		[editKey(HOST_1_INSTANCE, GW1)]: [{ targetInstanceId: HOST_2_INSTANCE, targetGateway: GW3 }],
		[editKey(HOST_2_INSTANCE, GW3)]: [{ targetInstanceId: HOST_1_INSTANCE, targetGateway: GW1 }],
	};
	const edges = buildEdges(edits);
	assert.strictEqual(edges.length, 1, "two links between the same endpoints are one line, not two");
	assert.strictEqual(edges[0].forward, true);
	assert.strictEqual(edges[0].reverse, true);
});

test("a ONE-WAY link renders as a one-way edge — the config is not reported as symmetric", () => {
	// This is the property the whole edge model exists for. The owner's ruling is that DRAWING an
	// edge creates the return link; that must not leak into READING, or a pre-existing one-way link
	// would display as two-way and the next save would silently create the direction it invented.
	const edits = {
		[editKey(HOST_1_INSTANCE, GW1)]: [{ targetInstanceId: HOST_2_INSTANCE, targetGateway: GW3 }],
	};
	const edges = buildEdges(edits);
	assert.strictEqual(edges.length, 1);
	assert.notStrictEqual(edges[0].forward, edges[0].reverse, "exactly one direction must be set");
});

test("reading a one-way link and saving it back does not invent the return link", () => {
	const loaded = editsFromLinks([
		{ sourceInstanceId: HOST_1_INSTANCE, gatewayName: GW1, targets: [{ targetInstanceId: HOST_2_INSTANCE, targetGateway: GW3 }] },
	]);
	// A load followed by no gesture must be clean: nothing to save means nothing gets written, so
	// the asymmetry survives untouched.
	assert.deepStrictEqual(dirtyKeys(loaded, loaded), []);
	assert.deepStrictEqual(loaded[editKey(HOST_2_INSTANCE, GW3)], undefined,
		"the reverse key must not materialise merely from reading");
});

test("edge identity is canonical — storage order does not produce two different edges", () => {
	const forwardFirst = buildEdges({
		[editKey(HOST_1_INSTANCE, GW1)]: [{ targetInstanceId: HOST_2_INSTANCE, targetGateway: GW3 }],
	});
	const reverseOnly = buildEdges({
		[editKey(HOST_2_INSTANCE, GW3)]: [{ targetInstanceId: HOST_1_INSTANCE, targetGateway: GW1 }],
	});
	assert.strictEqual(forwardFirst[0].id, reverseOnly[0].id,
		"the same pair of endpoints is the same edge whichever direction was stored");
});

// ── Editing gestures ────────────────────────────────────────────────────────

test("drawing an edge stages BOTH directions", () => {
	const staged = applyConnect({}, {
		sourceInstanceId: HOST_1_INSTANCE,
		sourceGateway: GW1,
		targetInstanceId: HOST_2_INSTANCE,
		targetGateway: GW3,
	});
	assert.deepStrictEqual(staged[editKey(HOST_1_INSTANCE, GW1)], [{ targetInstanceId: HOST_2_INSTANCE, targetGateway: GW3 }]);
	assert.deepStrictEqual(staged[editKey(HOST_2_INSTANCE, GW3)], [{ targetInstanceId: HOST_1_INSTANCE, targetGateway: GW1 }]);
	assert.deepStrictEqual(dirtyKeys(staged, {}).length, 2, "both directions are saved, so both keys are dirty");
});

test("deleting an edge clears both directions, including one that was one-way", () => {
	const oneWay = {
		[editKey(HOST_1_INSTANCE, GW1)]: [{ targetInstanceId: HOST_2_INSTANCE, targetGateway: GW3 }],
	};
	const cleared = applyDisconnect(oneWay, {
		sourceInstanceId: HOST_1_INSTANCE,
		sourceGateway: GW1,
		targetInstanceId: HOST_2_INSTANCE,
		targetGateway: GW3,
	});
	assert.deepStrictEqual(buildEdges(cleared), [], "no edge survives the delete");
	assert.deepStrictEqual(cleared[editKey(HOST_1_INSTANCE, GW1)], []);
});

test("connecting is idempotent — re-drawing an existing edge does not duplicate the target", () => {
	const once = applyConnect({}, {
		sourceInstanceId: HOST_1_INSTANCE, sourceGateway: GW1,
		targetInstanceId: HOST_2_INSTANCE, targetGateway: GW3,
	});
	const twice = applyConnect(once, {
		sourceInstanceId: HOST_1_INSTANCE, sourceGateway: GW1,
		targetInstanceId: HOST_2_INSTANCE, targetGateway: GW3,
	});
	assert.strictEqual(twice[editKey(HOST_1_INSTANCE, GW1)].length, 1);
});

test("an instance cannot gateway to itself — the edits are returned untouched", () => {
	const before = { [editKey(HOST_1_INSTANCE, GW1)]: [] };
	const after = applyConnect(before, {
		sourceInstanceId: HOST_1_INSTANCE, sourceGateway: GW1,
		targetInstanceId: HOST_1_INSTANCE, targetGateway: GW3,
	});
	assert.strictEqual(after, before, "an illegal connect is a no-op, not a staged write the controller rejects");
});

test("MULTI-TARGET survives: a gateway keeps every destination it holds", () => {
	// Owner decision: one gateway may hold several destinations, because the in-game on-arrival
	// chooser depends on it. A canvas that quietly replaced the target on each new edge would delete
	// that feature without anyone noticing.
	const third = 999000111;
	let edits = applyConnect({}, {
		sourceInstanceId: HOST_1_INSTANCE, sourceGateway: GW1,
		targetInstanceId: HOST_2_INSTANCE, targetGateway: GW3,
	});
	edits = applyConnect(edits, {
		sourceInstanceId: HOST_1_INSTANCE, sourceGateway: GW1,
		targetInstanceId: third, targetGateway: GW1,
	});
	assert.strictEqual(edits[editKey(HOST_1_INSTANCE, GW1)].length, 2, "the second destination must not replace the first");
	assert.strictEqual(buildEdges(edits).length, 2, "one handle, two edges");
});

// ── Dirty tracking ──────────────────────────────────────────────────────────

test("an untouched load is not dirty", () => {
	const loaded = editsFromLinks([
		{ sourceInstanceId: HOST_1_INSTANCE, gatewayName: GW1, targets: [{ targetInstanceId: HOST_2_INSTANCE, targetGateway: GW3 }] },
		{ sourceInstanceId: HOST_2_INSTANCE, gatewayName: GW3, targets: [{ targetInstanceId: HOST_1_INSTANCE, targetGateway: GW1 }] },
	]);
	assert.deepStrictEqual(dirtyKeys(loaded, loaded), [], "opening the tab must not offer to save anything");
});

test("target order alone is not a change", () => {
	const a = { [editKey(HOST_1_INSTANCE, GW1)]: [
		{ targetInstanceId: HOST_2_INSTANCE, targetGateway: GW3 },
		{ targetInstanceId: 5, targetGateway: GW1 },
	] };
	const b = { [editKey(HOST_1_INSTANCE, GW1)]: [
		{ targetInstanceId: 5, targetGateway: GW1 },
		{ targetInstanceId: HOST_2_INSTANCE, targetGateway: GW3 },
	] };
	assert.deepStrictEqual(dirtyKeys(a, b), [], "which edge was drawn first is not config");
});

test("clearing a gateway to empty IS dirty — an empty list disables it, and must be saved", () => {
	const baseline = { [editKey(HOST_1_INSTANCE, GW1)]: [{ targetInstanceId: HOST_2_INSTANCE, targetGateway: GW3 }] };
	const cleared = { [editKey(HOST_1_INSTANCE, GW1)]: [] };
	assert.deepStrictEqual(dirtyKeys(cleared, baseline), [editKey(HOST_1_INSTANCE, GW1)]);
});

// ── Node graph ──────────────────────────────────────────────────────────────

test("host groups precede their children in the nodes array", () => {
	// Hard React Flow requirement, not a style choice: "It's important that your parent nodes appear
	// before their children in the nodes array to get processed correctly." Violating it does not
	// throw — children simply fail to attach to their parent.
	const { nodes } = buildGraph(TREE, {});
	const firstInstanceIndex = nodes.findIndex(n => n.type === "instance");
	const lastGroupIndex = nodes.map(n => n.type).lastIndexOf("group");
	assert.ok(firstInstanceIndex > lastGroupIndex, "every group must come before every instance");

	for (const node of nodes.filter(n => n.type === "instance")) {
		const parentIndex = nodes.findIndex(n => n.id === node.parentId);
		assert.ok(parentIndex >= 0, `parent ${node.parentId} must exist`);
		assert.ok(parentIndex < nodes.indexOf(node), "a child must follow its own parent");
	}
});

test("each instance node is parented, clamped to its host, and carries all four gateways", () => {
	const { nodes } = buildGraph(TREE, {});
	const instances = nodes.filter(n => n.type === "instance");
	assert.strictEqual(instances.length, 2);
	for (const node of instances) {
		assert.strictEqual(node.extent, "parent", "a node must not be draggable out of its host box");
		assert.ok(node.parentId.startsWith("host:"));
		assert.strictEqual(Object.keys(node.data.gateways).length, 4);
	}
});

test("unassigned instances get their own group rather than vanishing", () => {
	const { nodes } = buildGraph({ hosts: [], unassignedInstances: [
		{ instanceId: 7, instanceName: "orphan", status: "stopped", connected: false },
	] }, {});
	assert.strictEqual(nodes.filter(n => n.type === "group").length, 1);
	assert.strictEqual(nodes.find(n => n.type === "instance").data.online, false);
});

test("online means connected AND running — the controller's rule, not just connected", () => {
	const { nodes } = buildGraph({ hosts: [{
		hostId: 1, hostName: "h", connected: true,
		instances: [{ instanceId: 3, instanceName: "starting", status: "starting", connected: true }],
	}] }, {});
	assert.strictEqual(nodes.find(n => n.type === "instance").data.online, false);
});

test("an empty tree yields an empty graph rather than throwing", () => {
	assert.deepStrictEqual(buildGraph(null, {}), { nodes: [], edges: [] });
	assert.deepStrictEqual(buildGraph({}, {}), { nodes: [], edges: [] });
});

// ── Surviving a server push ─────────────────────────────────────────────────

test("a rebuilt graph keeps where the user dragged a node", () => {
	// The tree is re-pushed on every platform status change. Without this, each push hands React Flow
	// a fresh array carrying LAYOUT positions, so nodes snap back to the grid while being dragged.
	const first = buildGraph(TREE, {}).nodes;
	const dragged = first.map(n => (n.type === "instance" ? { ...n, position: { x: 999, y: 42 }, selected: true } : n));
	const rebuilt = preservePositions(dragged, buildGraph(TREE, {}).nodes);
	const instance = rebuilt.find(n => n.type === "instance");
	assert.deepStrictEqual(instance.position, { x: 999, y: 42 });
	assert.strictEqual(instance.selected, true, "selection is user state too");
});

test("a rebuild still refreshes server-owned data — only position and selection are preserved", () => {
	const stale = buildGraph(TREE, {}).nodes.map(n => (n.type === "instance" ? { ...n, position: { x: 5, y: 5 } } : n));
	const linked = {
		[editKey(HOST_1_INSTANCE, GW1)]: [{ targetInstanceId: HOST_2_INSTANCE, targetGateway: GW3 }],
	};
	const rebuilt = preservePositions(stale, buildGraph(TREE, linked).nodes);
	const host1 = rebuilt.find(n => n.id === instanceNodeId(HOST_1_INSTANCE));
	assert.strictEqual(host1.data.gateways[GW1].outgoing, 1, "new config must reach the node");
	assert.deepStrictEqual(host1.position, { x: 5, y: 5 }, "...without resetting the drag");
});

test("a node that disappeared does not linger, and a new one takes its layout position", () => {
	const previous = [{ id: instanceNodeId(HOST_1_INSTANCE), position: { x: 1, y: 1 } }];
	const rebuilt = preservePositions(previous, buildGraph(TREE, {}).nodes);
	assert.strictEqual(rebuilt.some(n => n.id === "instance:99999"), false);
	const host2 = rebuilt.find(n => n.id === instanceNodeId(HOST_2_INSTANCE));
	assert.notDeepStrictEqual(host2.position, { x: 1, y: 1 }, "an unseen node keeps its computed layout");
});

// ── Handle usage, for the disabled affordance ───────────────────────────────

test("a gateway with no outgoing links is reported as having none", () => {
	const edits = {
		[editKey(HOST_1_INSTANCE, GW1)]: [{ targetInstanceId: HOST_2_INSTANCE, targetGateway: GW3 }],
	};
	const usage = gatewayUsage(edits);
	assert.deepStrictEqual(usage.get(HOST_1_INSTANCE).get(GW1), { outgoing: 1, incoming: 0 });
	// The arrival end has an INCOMING link but no outgoing one: a platform can land there and not
	// leave. Reported separately so the view can distinguish "disabled" from "arrival only".
	assert.deepStrictEqual(usage.get(HOST_2_INSTANCE).get(GW3), { outgoing: 0, incoming: 1 });
});

// ── Id round-trips ──────────────────────────────────────────────────────────

test("ids parse back to what built them", () => {
	assert.deepStrictEqual(parseEditKey(editKey(HOST_1_INSTANCE, GW1)), {
		sourceInstanceId: HOST_1_INSTANCE, gatewayName: GW1,
	});
	assert.strictEqual(instanceIdFromNodeId(instanceNodeId(HOST_2_INSTANCE)), HOST_2_INSTANCE);
	assert.strictEqual(gatewayFromHandleId(sourceHandleId(GW1)), GW1);
	assert.strictEqual(gatewayFromHandleId(targetHandleId(GW3)), GW3);
});

test("malformed ids return null instead of a plausible-looking wrong answer", () => {
	assert.strictEqual(parseEditKey("nocolon"), null);
	assert.strictEqual(parseEditKey(":leading"), null);
	assert.strictEqual(instanceIdFromNodeId("host:1"), null);
	assert.strictEqual(instanceIdFromNodeId(null), null);
	assert.strictEqual(gatewayFromHandleId("x:whatever"), null);
	assert.strictEqual(gatewayFromHandleId(null), null);
});

test("malformed link rows are skipped, not turned into edges to instance NaN", () => {
	const edits = editsFromLinks([
		null,
		{ sourceInstanceId: HOST_1_INSTANCE, gatewayName: "", targets: [] },
		{ sourceInstanceId: HOST_1_INSTANCE, gatewayName: GW1, targets: [{ targetInstanceId: HOST_2_INSTANCE, targetGateway: GW3 }] },
	]);
	assert.deepStrictEqual(Object.keys(edits), [editKey(HOST_1_INSTANCE, GW1)]);
	assert.strictEqual(buildEdges(edits).length, 1);
});

test("a target row missing its gateway name inherits the source gateway, as the controller does", () => {
	const edits = editsFromLinks([
		{ sourceInstanceId: HOST_1_INSTANCE, gatewayName: GW1, targets: [{ targetInstanceId: HOST_2_INSTANCE }] },
	]);
	assert.strictEqual(edits[editKey(HOST_1_INSTANCE, GW1)][0].targetGateway, GW1);
});
