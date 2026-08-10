"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const motionSrc = fs.readFileSync(
	path.join(__dirname, "..", "web", "gateway", "transfer-motion.ts"), "utf8",
);

const { groupEdgeShips } = require(path.join(__dirname, "..", "dist", "node", "shared", "transfer-status.js"));
const ship = (transferId, status, sourceInstanceId, platformName) =>
	({ transferId, status, sourceInstanceId, targetInstanceId: 99, platformName });

const forward = () => false;

test("in-transit transfers stay individual; resting ones become markers", () => {
	const { transit, markers } = groupEdgeShips([
		ship("a", "transporting", 1, "alpha"),
		ship("b", "transporting", 1, "beta"),
		ship("c", "completed", 1, "gamma"),
	], forward);

	assert.equal(transit.length, 2, "both in-transit ships animate separately");
	assert.equal(markers.length, 1, "the arrived one collapses to a single marker");
	assert.equal(markers[0].tone, "success");
	assert.equal(markers[0].distance, 1, "arrived sits at the destination end");
	assert.equal(markers[0].count, 1);
});

test("several transfers in the same phase collapse to ONE marker carrying the count", () => {
	const { markers } = groupEdgeShips([
		ship("a", "completed", 1, "alpha"),
		ship("b", "completed", 1, "beta"),
		ship("c", "completed", 1, "gamma"),
	], forward);

	assert.equal(markers.length, 1, "three arrivals draw one marker, not three");
	assert.equal(markers[0].count, 3);
	assert.deepEqual(markers[0].platformNames, ["alpha", "beta", "gamma"]);
});

test("each phase gets its own marker at its own position", () => {
	const { markers } = groupEdgeShips([
		ship("a", "awaiting_validation", 1),
		ship("b", "completed", 1),
		ship("c", "failed", 1),
	], forward);

	const byTone = Object.fromEntries(markers.map(m => [m.tone, m]));
	assert.equal(byTone.holding.distance, 0.5, "validating sits mid-edge");
	assert.equal(byTone.success.distance, 1, "arrived sits at the end");
	assert.equal(byTone.failure.distance, 0, "failed returns to the start");
	assert.equal(markers.length, 3);
});

test("cleanup_failed stays at the destination but counts as a failure", () => {
	const { markers } = groupEdgeShips([ship("a", "cleanup_failed", 1)], forward);

	assert.equal(markers.length, 1);
	assert.equal(markers[0].tone, "failure", "a cleanup failure must not read as a clean arrival");
	assert.equal(markers[0].distance, 1, "the platform really is at the destination");
});

test("a failure that returned and one that arrived are separate markers, both red", () => {
	const { markers } = groupEdgeShips([
		ship("a", "failed", 1),
		ship("b", "cleanup_failed", 1),
	], forward);

	assert.equal(markers.length, 2, "same tone, different positions — they cannot share a marker");
	assert.deepEqual(markers.map(m => m.tone).sort(), ["failure", "failure"]);
	assert.deepEqual(markers.map(m => m.distance).sort(), [0, 1]);
});

test("a transfer running against the edge's orientation is mirrored", () => {
	const reversed = () => true;
	const { markers } = groupEdgeShips([ship("a", "completed", 2)], reversed);

	assert.equal(markers[0].distance, 0,
		"arrived at the far end of a reversed transfer is distance 0 on this edge");
});

test("an unmapped status draws nothing rather than guessing a position", () => {
	const { transit, markers } = groupEdgeShips([
		ship("a", "in_progress", 1),
		ship("b", "unknown", 1),
	], forward);

	assert.equal(transit.length, 0);
	assert.equal(markers.length, 0);
});

test("terminal markers linger ten seconds", () => {
	assert.match(motionSrc, /TERMINAL_LINGER_MS = 10000/,
		"arrived and failed hold for 10s before fading");
});
