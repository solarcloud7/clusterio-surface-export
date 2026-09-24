"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CAPTION_CLEARANCE, CAPTION_WIDTH, GATE_CENTRE_OFFSET_Y, floatingEdgeEndpoints, nodeCircle, nodeFootprint } = require("../dist/node/shared/edge-geometry");

const SIZE = { width: 150, height: 150 };
const gateway = (x, y) => nodeFootprint({ x, y }, SIZE, 150, GATE_CENTRE_OFFSET_Y, CAPTION_CLEARANCE, CAPTION_WIDTH);
const circle = (x, y) => nodeCircle({ x, y }, SIZE, 150, GATE_CENTRE_OFFSET_Y);
const inside = (point, x, y) => (point.x > x && point.x < x + 150 && point.y > y && point.y < y + 150)
	|| (point.x > x + 75 - CAPTION_WIDTH / 2 && point.x < x + 75 + CAPTION_WIDTH / 2 && point.y > y - CAPTION_CLEARANCE && point.y < y);

test("the circle endpoints put vertical links inside the gateway art and caption (control)", () => {
	const ends = floatingEdgeEndpoints(circle(0, 0), circle(0, 300));
	assert.ok(inside({ x: ends.sourceX, y: ends.sourceY }, 0, 0), `source ${ends.sourceY}`);
	assert.ok(inside({ x: ends.targetX, y: ends.targetY }, 0, 300), `target ${ends.targetY}`);
});

test("vertical links end below the upper gateway and above the lower caption, in both directions", () => {
	for (const [from, to] of [[[0, 0], [0, 300]], [[0, 300], [0, 0]]]) {
		const ends = floatingEdgeEndpoints(gateway(...from), gateway(...to));
		assert.equal(inside({ x: ends.sourceX, y: ends.sourceY }, ...from), false, JSON.stringify(ends));
		assert.equal(inside({ x: ends.targetX, y: ends.targetY }, ...to), false, JSON.stringify(ends));
	}
	const down = floatingEdgeEndpoints(gateway(0, 0), gateway(0, 300));
	assert.ok(down.sourceY >= 150 && down.targetY <= 300 - CAPTION_CLEARANCE, JSON.stringify(down));
});

test("horizontal links keep the endpoints they had on the circle", () => {
	assert.deepEqual(floatingEdgeEndpoints(gateway(0, 0), gateway(400, 0)), floatingEdgeEndpoints(circle(0, 0), circle(400, 0)));
	assert.deepEqual(floatingEdgeEndpoints(gateway(400, 0), gateway(0, 0)), floatingEdgeEndpoints(circle(400, 0), circle(0, 0)));
});

test("links at every angle start outside the source gateway and its caption", () => {
	const targets = [[-600, -472], [600, -472]];
	for (let degrees = 0; degrees < 360; degrees += 5) {
		const radians = degrees * Math.PI / 180;
		targets.push([Math.round(Math.cos(radians) * 600), Math.round(Math.sin(radians) * 600)]);
	}
	for (const target of targets) {
		const ends = floatingEdgeEndpoints(gateway(0, 0), gateway(...target));
		assert.equal(inside({ x: ends.sourceX, y: ends.sourceY }, 0, 0), false, `${target}: ${JSON.stringify(ends)}`);
	}
});

test("links between gateways dragged close together shrink smoothly instead of crossing", () => {
	let previous = null;
	for (let gap = 260; gap >= 20; gap -= 1) {
		const ends = floatingEdgeEndpoints(gateway(0, 0), gateway(0, gap));
		assert.ok(ends.sourceY < ends.targetY, `${gap}px: ${JSON.stringify(ends)}`);
		if (previous) {
			assert.ok(Math.abs(ends.sourceY - previous.sourceY) <= 1.5 && Math.abs(ends.targetY + 1 - previous.targetY) <= 1.5,
				`${gap}px jumps from ${JSON.stringify(previous)} to ${JSON.stringify(ends)}`);
		}
		previous = ends;
	}
});
