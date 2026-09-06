import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyGatewayMap } from "../../tools/surface-export/check-gateway-map.mjs";

function snapshot(layout = "one_gate") {
	const locations = { surfexp_gateway_hub: { hidden: layout !== "one_gate" } };
	for (let i = 1; i <= 4; i++) locations[`surfexp_gateway_${i}`] = { hidden: layout !== "multi" };
	const routes = {};
	if (layout === "one_gate") {
		for (const planet of ["nauvis", "vulcanus", "gleba", "fulgora", "aquilo"]) {
			routes[`surfexp_gateway_link_hub${planet === "nauvis" ? "" : `_${planet}`}`] = {
				from: planet, to: "surfexp_gateway_hub",
			};
		}
	} else {
		for (let i = 1; i <= 4; i++) routes[`surfexp_gateway_link_${i}`] = { from: "nauvis", to: `surfexp_gateway_${i}` };
	}
	return { instance: "test-instance", mod: "0.6.4", layout, locations, routes,
		platforms: [{ index: 42, name: "existing", force: "player", location: "nauvis" }] };
}

test("accepts both layouts with only their active connections", () => {
	for (const layout of ["one_gate", "multi"]) verifyGatewayMap(snapshot(layout), { version: "0.6.4" });
});

test("rejects dangling connections even when hidden is true", () => {
	const state = snapshot();
	state.routes.surfexp_gateway_link_1 = { from: "nauvis", to: "surfexp_gateway_1", hidden: true };
	assert.throws(() => verifyGatewayMap(state), /inactive routes must be absent/);
});

test("rejects a missing planet link and incorrect location visibility", () => {
	const missing = snapshot();
	delete missing.routes.surfexp_gateway_link_hub_aquilo;
	assert.throws(() => verifyGatewayMap(missing), /inactive routes must be absent/);
	const visible = snapshot();
	visible.locations.surfexp_gateway_1.hidden = false;
	assert.throws(() => verifyGatewayMap(visible), /visibility/);
});

test("baseline comparison catches missing platforms and the wrong instance", () => {
	const baseline = snapshot();
	verifyGatewayMap(snapshot(), { baseline });
	const missing = snapshot();
	missing.platforms = [];
	assert.throws(() => verifyGatewayMap(missing, { baseline }), /platform identities or locations changed/);
	assert.throws(() => verifyGatewayMap({ ...snapshot(), instance: "other" }, { baseline }), /another instance/);
	assert.throws(() => verifyGatewayMap(snapshot(), { version: "0.6.2" }), /loaded mod version/);
});
