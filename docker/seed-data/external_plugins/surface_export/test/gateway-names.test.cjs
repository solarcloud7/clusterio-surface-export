"use strict";
const test = require("node:test");
const assert = require("node:assert");

const {
	GATEWAY_PREFIX,
	ONE_GATE_NAME,
	ONE_GATE_NAMES,
} = require("../dist/node/shared/dto.js");

test("the Gateway hub is the only gateway", () => {
	assert.deepStrictEqual(ONE_GATE_NAMES, [ONE_GATE_NAME]);
	assert.strictEqual(ONE_GATE_NAME, "surfexp_gateway_hub");
});

test("the hub name keeps the gateway prefix — Lua's is_gateway is a clamped prefix compare", () => {
	assert.ok(ONE_GATE_NAME.startsWith(GATEWAY_PREFIX), `${ONE_GATE_NAME} must start with ${GATEWAY_PREFIX}`);
	assert.ok(ONE_GATE_NAME.length > GATEWAY_PREFIX.length, "the name must be longer than the prefix itself");
});
