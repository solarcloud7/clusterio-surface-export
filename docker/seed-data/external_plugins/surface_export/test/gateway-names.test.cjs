"use strict";
const test = require("node:test");
const assert = require("node:assert");

const {
	ALL_GATEWAY_NAMES,
	GATEWAY_PREFIX,
	LEGACY_GATEWAY_NAMES,
	ONE_GATE_NAME,
	ONE_GATE_NAMES,
} = require("../dist/node/shared/dto.js");

test("the Gateway hub is the only gateway that can be linked", () => {
	assert.deepStrictEqual(ONE_GATE_NAMES, [ONE_GATE_NAME]);
	assert.strictEqual(ONE_GATE_NAME, "surfexp_gateway_hub");
});

test("the hub name keeps the gateway prefix — Lua's is_gateway is a clamped prefix compare", () => {
	assert.ok(ONE_GATE_NAME.startsWith(GATEWAY_PREFIX), `${ONE_GATE_NAME} must start with ${GATEWAY_PREFIX}`);
	assert.ok(ONE_GATE_NAME.length > GATEWAY_PREFIX.length, "the name must be longer than the prefix itself");
});

test("stored links on the numbered gateways of older configurations still load", () => {
	assert.deepStrictEqual(LEGACY_GATEWAY_NAMES, [1, 2, 3, 4].map(i => `${GATEWAY_PREFIX}${i}`));
	for (const name of [...LEGACY_GATEWAY_NAMES, ONE_GATE_NAME]) {
		assert.ok(ALL_GATEWAY_NAMES.includes(name), `${name} must survive a load`);
	}
	assert.strictEqual(new Set(ALL_GATEWAY_NAMES).size, ALL_GATEWAY_NAMES.length, "no duplicates");
});
