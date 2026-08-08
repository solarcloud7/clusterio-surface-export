"use strict";
const test = require("node:test");
const assert = require("node:assert");

const {
	endpointSide,
	floatingEdgeEndpoints,
	nodeCircle,
} = require("../dist/node/shared/edge-geometry.js");

// NOTE: the gateway PALETTE moved to web/gateway/gateway-colours.ts, where it belongs — it is
// presentation, and shared/ is not a dumping ground for “things I want to unit test”. The cost is
// real and stated rather than hidden: tsconfig.node.json excludes web/**, so nothing under web/ is
// reachable from dist/node, and the assertion that the four gateway colours are DISTINCT REAL hex
// strings (the guard against React Flow's example trick of using a handle id as a stroke) no
// longer runs anywhere. It survives as a comment on the constant. If web/ ever becomes testable,
// bring it back.

/**
 * Floating-edge geometry.
 *
 * Worth testing rather than eyeballing: a sign flip or a swapped axis still renders a line, just the
 * wrong one, and "the edge looks a bit off" is not a failure anyone chases down. These pin the
 * properties that make it right — endpoints ON the boundary, ON the line between centres, and facing
 * each other.
 */
const D = 150;

test("endpoints land on each circle's boundary, facing the other node", () => {
	const a = { x: 0, y: 0, radius: 50 };
	const b = { x: 200, y: 0, radius: 50 };
	const { sourceX, sourceY, targetX, targetY } = floatingEdgeEndpoints(a, b);
	// Horizontal pair: leave a's right edge, arrive at b's left edge.
	assert.strictEqual(sourceX, 50);
	assert.strictEqual(sourceY, 0);
	assert.strictEqual(targetX, 150);
	assert.strictEqual(targetY, 0);
});

test("the endpoints sit exactly one radius from their centres, at any angle", () => {
	const a = { x: 10, y: 20, radius: 40 };
	const b = { x: 310, y: 220, radius: 25 };
	const e = floatingEdgeEndpoints(a, b);
	assert.ok(Math.abs(Math.hypot(e.sourceX - a.x, e.sourceY - a.y) - a.radius) < 1e-9);
	assert.ok(Math.abs(Math.hypot(e.targetX - b.x, e.targetY - b.y) - b.radius) < 1e-9);
});

test("both endpoints lie on the straight line between the two centres", () => {
	const a = { x: -30, y: 90, radius: 33 };
	const b = { x: 140, y: -60, radius: 17 };
	const e = floatingEdgeEndpoints(a, b);
	// Cross product of (centre->centre) with (centre->endpoint) is zero when collinear.
	const cross = (px, py) => (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
	assert.ok(Math.abs(cross(e.sourceX, e.sourceY)) < 1e-6);
	assert.ok(Math.abs(cross(e.targetX, e.targetY)) < 1e-6);
});

test("swapping the nodes mirrors the endpoints rather than producing something new", () => {
	const a = { x: 0, y: 0, radius: 30 };
	const b = { x: 100, y: 100, radius: 45 };
	const forward = floatingEdgeEndpoints(a, b);
	const backward = floatingEdgeEndpoints(b, a);
	assert.ok(Math.abs(forward.sourceX - backward.targetX) < 1e-9);
	assert.ok(Math.abs(forward.sourceY - backward.targetY) < 1e-9);
	assert.ok(Math.abs(forward.targetX - backward.sourceX) < 1e-9);
	assert.ok(Math.abs(forward.targetY - backward.sourceY) < 1e-9);
});

test("concentric nodes collapse to the centres instead of dividing by zero", () => {
	// Two nodes dragged exactly on top of each other. NaN here would take the whole SVG path with it,
	// and React Flow would render nothing anywhere with no error.
	const a = { x: 50, y: 50, radius: 20 };
	const e = floatingEdgeEndpoints(a, { ...a });
	for (const value of Object.values(e)) {
		assert.ok(Number.isFinite(value), `expected a finite coordinate, got ${value}`);
	}
	assert.deepStrictEqual(e, { sourceX: 50, sourceY: 50, targetX: 50, targetY: 50 });
});

test("the reported side follows the DOMINANT axis", () => {
	const origin = { x: 0, y: 0, radius: 10 };
	assert.strictEqual(endpointSide(origin, { x: 100, y: 10, radius: 10 }), "right");
	assert.strictEqual(endpointSide(origin, { x: -100, y: 10, radius: 10 }), "left");
	assert.strictEqual(endpointSide(origin, { x: 10, y: 100, radius: 10 }), "bottom");
	assert.strictEqual(endpointSide(origin, { x: 10, y: -100, radius: 10 }), "top");
});

// ── Node -> circle ──────────────────────────────────────────────────────────

test("a node becomes its centre and INSCRIBED radius", () => {
	const circle = nodeCircle({ x: 100, y: 200 }, { width: 150, height: 150 }, D);
	assert.deepStrictEqual(circle, { x: 175, y: 275, radius: 75 });
});

test("a non-square node uses the SMALLER half-side, so the boundary stays inside the box", () => {
	// Circumscribing would put the endpoint outside the node and leave a visible gap.
	assert.strictEqual(nodeCircle({ x: 0, y: 0 }, { width: 200, height: 100 }, D).radius, 50);
});

test("an unmeasured node falls back to the layout diameter rather than collapsing", () => {
	// React Flow reports undefined (not 0) before the first measure pass. Treating that as zero would
	// put every endpoint at the node's top-left corner on the first frame.
	assert.deepStrictEqual(nodeCircle({ x: 0, y: 0 }, undefined, D), { x: 75, y: 75, radius: 75 });
	assert.deepStrictEqual(nodeCircle({ x: 0, y: 0 }, { width: undefined, height: undefined }, D).radius, 75);
});

test("a node with no position yields null rather than NaN coordinates", () => {
	assert.strictEqual(nodeCircle(null, { width: 10, height: 10 }, D), null);
	assert.strictEqual(nodeCircle(undefined, undefined, D), null);
	assert.strictEqual(nodeCircle({ x: NaN, y: 0 }, undefined, D), null);
});
