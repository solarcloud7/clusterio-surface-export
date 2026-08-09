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

const HOST_2 = 1285554351;
const HOST_3 = 999000111;


test("each mode exposes its own gateway set, and one_gate is the default", () => {
	assert.strictEqual(DEFAULT_GATEWAY_MODE, "one_gate");
	assert.deepStrictEqual(gatewayNamesFor("one_gate"), [ONE_GATE_NAME]);
	assert.deepStrictEqual(gatewayNamesFor("multi"), MULTI_GATEWAY_NAMES);
	assert.strictEqual(MULTI_GATEWAY_NAMES.length, 4);
});

test("the hub name keeps the gateway prefix — Lua's is_gateway is a clamped prefix compare", () => {
	assert.ok(ONE_GATE_NAME.startsWith(GATEWAY_PREFIX), `${ONE_GATE_NAME} must start with ${GATEWAY_PREFIX}`);
	assert.ok(ONE_GATE_NAME.length > GATEWAY_PREFIX.length, "the name must be longer than the prefix itself");
	for (const name of MULTI_GATEWAY_NAMES) {
		assert.ok(name.startsWith(GATEWAY_PREFIX));
	}
});

test("ALL_GATEWAY_NAMES is the union — the precondition for a lossless mode switch", () => {
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

test("Multi mode allows one destination per gateway across distinct instances", () => {
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

test("the cap is Multi-only — one-gate mode is not subject to it", () => {
	assert.strictEqual(gatewayNamesFor("one_gate").length, 1);
	assert.notDeepStrictEqual(gatewayNamesFor("one_gate"), gatewayNamesFor("multi"));
});
