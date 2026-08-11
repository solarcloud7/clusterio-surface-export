"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const distNode = path.join(__dirname, "..", "dist", "node");
const { ControllerPlugin } = require(path.join(distNode, "controller.js"));

function harness() {
	const broadcasts = [];
	const plugin = Object.create(ControllerPlugin.prototype);
	plugin.platformDepartureTimes = new Map();
	plugin.subscriptions = { queueTreeBroadcast: forceName => broadcasts.push(forceName) };
	return { plugin, broadcasts };
}

const DELETION_EVENT = { instanceId: 1, platformName: "", forceName: "player" };
const DEPARTURE_EVENT = { instanceId: 1, platformName: "lab-fixture", forceName: "player" };

test("a surface deletion reaches subscribers even though it names no platform", async () => {
	const { plugin, broadcasts } = harness();

	await ControllerPlugin.prototype.handlePlatformStateChanged.call(plugin, DELETION_EVENT);

	assert.deepEqual(broadcasts, ["player"],
		"the deleted platform's row survives in the canvas until a tree rebuild is broadcast");
});

test("a surface deletion does not stamp a departure time", async () => {
	const { plugin } = harness();

	await ControllerPlugin.prototype.handlePlatformStateChanged.call(plugin, DELETION_EVENT);

	assert.equal(plugin.platformDepartureTimes.size, 0,
		"a deleted platform never departed; a stamp here outlives the platform and would attach "
		+ "a bogus departureDateMs to the next platform that reuses the name");
});

test("a real departure DOES stamp, so the assertion above is not vacuous", async () => {
	const { plugin, broadcasts } = harness();

	await ControllerPlugin.prototype.handlePlatformStateChanged.call(plugin, DEPARTURE_EVENT);

	assert.deepEqual(broadcasts, ["player"]);
	assert.deepEqual([...plugin.platformDepartureTimes.keys()], ["lab-fixture"],
		"if this stops stamping, the empty-name test above proves nothing");
});

test("the empty string is the shape the instance actually sends", () => {
	const instanceSource = require("node:fs").readFileSync(path.join(__dirname, "..", "instance.ts"), "utf8");

	assert.match(instanceSource, /platformName:\s*String\(data\.platform_name \|\| ""\)/,
		"the Lua omits platform_name on deletion and the instance coerces it to \"\" — if this becomes "
		+ "null or undefined the deletion path still works, but these tests would stop pinning the real wire");
});
