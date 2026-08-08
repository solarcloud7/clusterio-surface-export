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

/**
 * The gateway-mode CONTRACT, which is controller-side.
 *
 * Scope, deliberately: everything here is imported by controller.ts and enforced there —
 * `handleSetGatewayLinkRequest` applies the Multi rules, `loadGatewayConfig` validates against the
 * union, and `gatewayMode()` parses the setting. None of it is UI.
 *
 * The canvas's own logic (node/edge projection, layout, handle ids) is NOT unit-tested and does not
 * belong here: it is UI, and UI is verified by driving the real thing. Those unit tests existed
 * briefly and were removed rather than left to imply coverage of a layer they were never going to
 * hold up.
 */
const HOST_2 = 1285554351;
const HOST_3 = 999000111;

// ── The name sets ───────────────────────────────────────────────────────────

test("each mode exposes its own gateway set, and one_gate is the default", () => {
	assert.strictEqual(DEFAULT_GATEWAY_MODE, "one_gate");
	assert.deepStrictEqual(gatewayNamesFor("one_gate"), [ONE_GATE_NAME]);
	assert.deepStrictEqual(gatewayNamesFor("multi"), MULTI_GATEWAY_NAMES);
	assert.strictEqual(MULTI_GATEWAY_NAMES.length, 4);
});

test("the hub name keeps the gateway prefix — Lua's is_gateway is a clamped prefix compare", () => {
	// module/core/gateway.lua does name:sub(1, #Gateway.PREFIX), and Lua's sub CLAMPS instead of
	// failing. A shorter name returns itself, the compare fails, and the location becomes invisible to
	// unlocking, arrival detection and the transfer trigger alike — rendering on the starmap while
	// doing nothing. This is the cheapest possible guard against reintroducing that.
	assert.ok(ONE_GATE_NAME.startsWith(GATEWAY_PREFIX), `${ONE_GATE_NAME} must start with ${GATEWAY_PREFIX}`);
	assert.ok(ONE_GATE_NAME.length > GATEWAY_PREFIX.length, "the name must be longer than the prefix itself");
	for (const name of MULTI_GATEWAY_NAMES) {
		assert.ok(name.startsWith(GATEWAY_PREFIX));
	}
});

test("ALL_GATEWAY_NAMES is the union — the precondition for a lossless mode switch", () => {
	// controller.ts validates the PERSISTED file against this, not the active set. Validating against
	// the active set would delete the other mode's links at the next boot: a destructive,
	// un-undoable side effect of changing a display setting.
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

// ── Multi Cluster's two rules ───────────────────────────────────────────────
// New enforcement: nothing capped a gateway's target list before, so these tests are the only thing
// standing between the owner's stated design and an unbounded list.

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
	// One gate, any number of destinations. checkMultiModeLink is simply never consulted in that mode
	// (controller.ts gates the whole block on `mode === "multi"`), which is the behaviour this pins.
	assert.strictEqual(gatewayNamesFor("one_gate").length, 1);
	assert.notDeepStrictEqual(gatewayNamesFor("one_gate"), gatewayNamesFor("multi"));
});
