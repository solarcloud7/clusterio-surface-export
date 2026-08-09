"use strict";

/**
 * What makes the platform tree rebroadcast.
 *
 * The tree renders each instance's connected/status pair, but every broadcast site the plugin had
 * was a plugin-domain event: an export stored, a platform state change, a transfer completing.
 * Cluster membership moves on its own schedule, so a host reconnecting — after a controller
 * restart, say — changed what the tree should show and nothing sent it.
 *
 * Measured on the dev cluster 2026-08-09: with the page open across a controller restart, both
 * hosts returned to `connected: true` and both instances to `running`, while the open page kept
 * rendering both instances offline for over a minute. No update was dropped by the page's revision
 * gate, because no update was ever sent.
 *
 * Clusterio gives a controller plugin onHostConnectionEvent and onInstanceStatusChanged for exactly
 * this. These pins assert the plugin implements both and broadcasts from each.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const controllerSource = fs.readFileSync(path.join(__dirname, "..", "controller.ts"), "utf8");

/** Body of a method on the ControllerPlugin class, by name. */
function methodBody(source, name) {
	const start = source.indexOf(`${name}(`);
	assert.notEqual(start, -1, `ControllerPlugin must implement ${name} — the tree cannot see cluster state without it`);
	const open = source.indexOf("{", start);
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		if (source[i] === "{") { depth += 1; }
		if (source[i] === "}") {
			depth -= 1;
			if (depth === 0) { return source.slice(open, i + 1); }
		}
	}
	throw new Error(`unbalanced braces reading ${name}`);
}

test("a host connecting or dropping rebroadcasts the tree", () => {
	assert.match(
		methodBody(controllerSource, "onHostConnectionEvent"),
		/queueTreeBroadcast\(/,
		"a host's connected flag is rendered by the tree, so its transitions must reach subscribers",
	);
});

test("an instance changing status rebroadcasts the tree", () => {
	assert.match(
		methodBody(controllerSource, "onInstanceStatusChanged"),
		/queueTreeBroadcast\(/,
		"the tree reads instance status, so a running/stopped transition must reach subscribers",
	);
});

test("the cluster-state broadcasts are not filtered down to one event kind", () => {
	// onHostConnectionEvent fires for connect/drop/resume/close. A branch that broadcasts on only
	// one of them reintroduces the defect for the others — a drop that never renders is the same
	// bug as a connect that never renders, pointed the other way.
	const body = methodBody(controllerSource, "onHostConnectionEvent");
	assert.doesNotMatch(
		body,
		/event\s*===/,
		"broadcast on every host connection event; the tree is rebuilt whole, so the kind does not matter",
	);
});
