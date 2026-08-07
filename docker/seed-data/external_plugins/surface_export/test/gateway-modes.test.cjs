"use strict";
const test = require("node:test");
const assert = require("node:assert");

const {
	ALL_GATEWAY_NAMES,
	DEFAULT_GATEWAY_MODE,
	GATEWAY_PREFIX,
	MULTI_GATEWAY_NAMES,
	ONE_GATE_NAME,
	checkMultiModeLink,
	gatewayNamesFor,
	parseGatewayMode,
} = require("../dist/node/shared/dto.js");
const {
	applyConnect,
	buildEdges,
	buildGraph,
	editKey,
	gatewayFromHandleId,
	sourceHandleId,
	targetHandleId,
} = require("../dist/node/shared/gateway-graph.js");

/**
 * The two cluster modes.
 *
 *   1 Gate Cluster (default) — one gate per instance, any number of destinations.
 *   Multi Cluster (advanced) — four gates, ONE destination each, and no two gates aimed at the
 *                              same instance.
 *
 * The rules in the second row are new: nothing capped a gateway's target list before, so these
 * tests are the only thing standing between "the owner's stated design" and an unbounded list.
 */
const HOST_1 = 472806668;
const HOST_2 = 1285554351;
const HOST_3 = 999000111;

const TREE = {
	hosts: [
		{ hostId: 1, hostName: "h1", connected: true, instances: [{ instanceId: HOST_1, instanceName: "i1", status: "running", connected: true }] },
		{ hostId: 2, hostName: "h2", connected: true, instances: [{ instanceId: HOST_2, instanceName: "i2", status: "running", connected: true }] },
	],
};

// ── The name sets ───────────────────────────────────────────────────────────

test("each mode exposes its own gateway set, and one_gate is the default", () => {
	assert.strictEqual(DEFAULT_GATEWAY_MODE, "one_gate");
	assert.deepStrictEqual(gatewayNamesFor("one_gate"), [ONE_GATE_NAME]);
	assert.deepStrictEqual(gatewayNamesFor("multi"), MULTI_GATEWAY_NAMES);
	assert.strictEqual(MULTI_GATEWAY_NAMES.length, 4);
});

test("the hub name keeps the gateway prefix — Lua's is_gateway is a clamped prefix compare", () => {
	// module/core/gateway.lua does name:sub(1, #Gateway.PREFIX), and Lua's sub CLAMPS instead of
	// failing. A shorter name returns itself, the compare fails, and the location becomes invisible to
	// unlocking, arrival detection and the transfer trigger alike — rendering on the starmap while
	// doing nothing. This is the cheapest possible guard against reintroducing that.
	assert.ok(ONE_GATE_NAME.startsWith(GATEWAY_PREFIX), `${ONE_GATE_NAME} must start with ${GATEWAY_PREFIX}`);
	assert.ok(ONE_GATE_NAME.length > GATEWAY_PREFIX.length, "the name must be longer than the prefix itself");
	for (const name of MULTI_GATEWAY_NAMES) {
		assert.ok(name.startsWith(GATEWAY_PREFIX));
	}
});

test("ALL_GATEWAY_NAMES is the union — the precondition for a lossless mode switch", () => {
	// The controller validates the PERSISTED file against this, not the active set. If it validated
	// against the active set, flipping the mode would delete the other mode's links at the next boot:
	// a destructive, un-undoable side effect of changing a display setting.
	for (const name of [...MULTI_GATEWAY_NAMES, ONE_GATE_NAME]) {
		assert.ok(ALL_GATEWAY_NAMES.includes(name), `${name} must survive a load in either mode`);
	}
	assert.strictEqual(new Set(ALL_GATEWAY_NAMES).size, ALL_GATEWAY_NAMES.length, "no duplicates");
});

test("an unrecognised mode falls back to one_gate and says so", () => {
	for (const bad of ["", "One_Gate", "four", null, undefined, 4, {}]) {
		const { mode, warning } = parseGatewayMode(bad);
		assert.strictEqual(mode, DEFAULT_GATEWAY_MODE, `${JSON.stringify(bad)} must fall back`);
		assert.ok(warning && warning.includes("gateway_mode"), "the fallback must be reported, not silent");
	}
	assert.deepStrictEqual(parseGatewayMode("multi"), { mode: "multi", warning: null });
	assert.deepStrictEqual(parseGatewayMode("one_gate"), { mode: "one_gate", warning: null });
});

// ── Multi Cluster's two rules ───────────────────────────────────────────────

test("Multi mode refuses a SECOND destination on one gateway", () => {
	const violation = checkMultiModeLink(MULTI_GATEWAY_NAMES[0], [
		{ targetInstanceId: HOST_2, targetGateway: MULTI_GATEWAY_NAMES[1] },
		{ targetInstanceId: HOST_3, targetGateway: MULTI_GATEWAY_NAMES[2] },
	], new Map());
	assert.ok(violation, "two targets on one gate must be refused");
	assert.ok(violation.includes(MULTI_GATEWAY_NAMES[0]), "the reason must name the offending gateway");
});

test("Multi mode refuses TWO gateways aimed at the same destination instance", () => {
	const others = new Map([
		[MULTI_GATEWAY_NAMES[1], [{ targetInstanceId: HOST_2, targetGateway: MULTI_GATEWAY_NAMES[3] }]],
	]);
	const violation = checkMultiModeLink(
		MULTI_GATEWAY_NAMES[0],
		[{ targetInstanceId: HOST_2, targetGateway: MULTI_GATEWAY_NAMES[2] }],
		others,
	);
	assert.ok(violation, "a second route to the same instance must be refused");
	assert.ok(violation.includes(String(HOST_2)), "the reason must name the instance already linked");
});

test("Multi mode allows one destination per gateway across four distinct instances", () => {
	const others = new Map([
		[MULTI_GATEWAY_NAMES[1], [{ targetInstanceId: HOST_3, targetGateway: MULTI_GATEWAY_NAMES[1] }]],
	]);
	assert.strictEqual(
		checkMultiModeLink(MULTI_GATEWAY_NAMES[0], [{ targetInstanceId: HOST_2, targetGateway: MULTI_GATEWAY_NAMES[0] }], others),
		null,
	);
});

test("clearing a gateway is always legal in Multi mode", () => {
	assert.strictEqual(checkMultiModeLink(MULTI_GATEWAY_NAMES[0], [], new Map()), null);
});

test("the rules are Multi-only: one-gate mode holds many destinations on its single gate", () => {
	let edits = {};
	for (const target of [HOST_2, HOST_3, 5, 6, 7]) {
		edits = applyConnect(edits, {
			sourceInstanceId: HOST_1, sourceGateway: ONE_GATE_NAME,
			targetInstanceId: target, targetGateway: ONE_GATE_NAME,
		});
	}
	assert.strictEqual(edits[editKey(HOST_1, ONE_GATE_NAME)].length, 5, "the one gate takes every destination");
	assert.strictEqual(buildEdges(edits, "one_gate").length, 5);
});

// ── Handle ids ──────────────────────────────────────────────────────────────

test("a side-qualified handle id still decodes to its gateway", () => {
	// One-gate nodes carry four handle pairs for ONE gateway, and React Flow requires distinct ids per
	// node — hence the @side suffix. It is presentation only: every side must decode back to the same
	// gateway, or a link drawn from the left would be stored as a different gateway than one drawn
	// from the right.
	for (const side of ["top", "right", "bottom", "left"]) {
		assert.strictEqual(gatewayFromHandleId(sourceHandleId(ONE_GATE_NAME, side)), ONE_GATE_NAME);
		assert.strictEqual(gatewayFromHandleId(targetHandleId(ONE_GATE_NAME, side)), ONE_GATE_NAME);
	}
	// Unqualified ids (multi mode) keep working unchanged.
	assert.strictEqual(gatewayFromHandleId(sourceHandleId(MULTI_GATEWAY_NAMES[0])), MULTI_GATEWAY_NAMES[0]);
});

test("edges name handles that actually exist on the node they attach to", () => {
	// A one-gate node renders only side-qualified handles, so an edge emitted without a side would
	// address a handle that is not there and silently fail to render.
	const oneGateEdges = buildEdges({
		[editKey(HOST_1, ONE_GATE_NAME)]: [{ targetInstanceId: HOST_2, targetGateway: ONE_GATE_NAME }],
	}, "one_gate");
	assert.ok(oneGateEdges[0].sourceHandle.includes("@"), "one-gate edges must name a side");
	assert.ok(oneGateEdges[0].targetHandle.includes("@"));

	const multiEdges = buildEdges({
		[editKey(HOST_1, MULTI_GATEWAY_NAMES[0])]: [{ targetInstanceId: HOST_2, targetGateway: MULTI_GATEWAY_NAMES[2] }],
	}, "multi");
	assert.ok(!multiEdges[0].sourceHandle.includes("@"), "multi edges address the gateway's own side");
	assert.ok(!multiEdges[0].targetHandle.includes("@"));
});

test("which side a link was drawn from does not change the edge's identity", () => {
	const edits = { [editKey(HOST_1, ONE_GATE_NAME)]: [{ targetInstanceId: HOST_2, targetGateway: ONE_GATE_NAME }] };
	assert.strictEqual(buildEdges(edits, "one_gate")[0].id, buildEdges(edits, "multi")[0].id,
		"edge identity comes from instance+gateway, never from handles");
});

// ── Projection ──────────────────────────────────────────────────────────────

test("a graph renders only the active mode's gateways", () => {
	const oneGate = buildGraph(TREE, {}, "one_gate").nodes.find(n => n.type === "instance");
	assert.deepStrictEqual(Object.keys(oneGate.data.gateways), [ONE_GATE_NAME]);

	const multi = buildGraph(TREE, {}, "multi").nodes.find(n => n.type === "instance");
	assert.deepStrictEqual(Object.keys(multi.data.gateways), MULTI_GATEWAY_NAMES);
});

test("the inactive mode's links are held, not shown — the switch is lossless", () => {
	// Both sets present at once, as they are on disk after a mode switch.
	const edits = {
		[editKey(HOST_1, ONE_GATE_NAME)]: [{ targetInstanceId: HOST_2, targetGateway: ONE_GATE_NAME }],
		[editKey(HOST_1, MULTI_GATEWAY_NAMES[0])]: [{ targetInstanceId: HOST_2, targetGateway: MULTI_GATEWAY_NAMES[0] }],
	};
	// buildEdges is deliberately NOT filtered by mode: it renders what the config holds, and the
	// node's handle set decides what is reachable. What matters is that neither call DESTROYS the
	// other mode's entry — the edits map is returned to the controller as-is.
	assert.strictEqual(Object.keys(edits).length, 2);
	for (const mode of ["one_gate", "multi"]) {
		buildGraph(TREE, edits, mode);
		assert.strictEqual(Object.keys(edits).length, 2, `${mode} must not mutate the edits it renders`);
	}
});
