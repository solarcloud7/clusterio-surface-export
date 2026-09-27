"use strict";


const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const controllerSource = fs.readFileSync(path.join(__dirname, "..", "controller.ts"), "utf8");

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
	const body = methodBody(controllerSource, "onHostConnectionEvent");
	assert.doesNotMatch(
		body,
		/event\s*===/,
		"broadcast on every host connection event; the tree is rebuilt whole, so the kind does not matter",
	);
});

test("planet policy, mod pack assignment and mod pack edits rebroadcast the tree", () => {
	const fields = controllerSource.match(/TREE_INSTANCE_CONFIG_FIELDS = new Set\(\[([^\]]*)\]\)/);
	assert.ok(fields, "the instance config fields the tree renders must be listed");
	for (const field of ["default_planet", "disabled_planets", "factorio.mod_pack_id"]) {
		assert.ok(fields[1].includes(field), `${field} is rendered by the tree`);
	}
	assert.match(methodBody(controllerSource, "onInstanceConfigFieldChanged"), /TREE_INSTANCE_CONFIG_FIELDS\.has\(field\)[^\n]*queueTreeBroadcast\(/);
	assert.match(methodBody(controllerSource, "onModPacksUpdated"), /queueTreeBroadcast\(/,
		"server destinations are a mod pack startup setting");
	assert.match(methodBody(controllerSource, "onControllerConfigFieldChanged"),
		/"controller\.default_mod_pack_id"\)[^\n]*queueTreeBroadcast\(/);
});
