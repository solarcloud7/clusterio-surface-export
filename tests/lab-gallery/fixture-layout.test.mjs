import assert from "node:assert/strict";
import test from "node:test";

import { buildBeltPilot, buildFiveByFiveLoop, buildSpecializedReachabilityFixture } from "./fixture-layout.mjs";

test("5x5 loop has sixteen unique perimeter belts with four directed corners", () => {
	const belts = buildFiveByFiveLoop({ x: 10, y: 20 });
	assert.equal(belts.length, 16);
	assert.equal(new Set(belts.map(row => `${row.position.x},${row.position.y}`)).size, 16);
	assert.deepEqual(belts.filter(row => row.corner).map(row => row.direction).sort(), ["east", "north", "south", "west"]);
	assert.ok(belts.every(row => row.name === "turbo-transport-belt"));
});

test("belt pilot separates immutable source loop from empty target (layout only)", () => {
	const pilot = buildBeltPilot();
	assert.equal(pilot.id, "belt-5x5-125-unstacked");
	assert.equal(pilot.sourceBelts.length, 16);
	assert.equal(pilot.targetBelts.length, 16);
	const source = new Set(pilot.sourceBelts.map(row => `${row.position.x},${row.position.y}`));
	assert.ok(pilot.targetBelts.every(row => !source.has(`${row.position.x},${row.position.y}`)));
	assert.equal(pilot.sourceSurface, "nauvis");
	assert.deepEqual(pilot.sourceBelts[0].position, { x: -16.5, y: -25.5 });
	assert.deepEqual(pilot.targetBelts[0].position, { x: 4.5, y: -25.5 });
	// The expected fingerprint (125/67/58/...) lives in the manifest, not in the layout builder.
	assert.equal(pilot.expected, undefined);
	assert.equal(pilot.sourceLineQuantities, undefined);
});

test("specialized reachability fixture is a stable platform identity + drill locator (no hardcoded fingerprint)", () => {
	assert.deepEqual(buildSpecializedReachabilityFixture(), {
		id: "specialized-fluid-reachability",
		platformName: "lab-specialized-fluid-r1",
		drillName: "electric-mining-drill",
	});
});
