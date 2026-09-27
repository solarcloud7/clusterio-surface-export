import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyGatewayMap } from "../../tools/surface-export/check-gateway-map.mjs";

function snapshot() {
	const locations = { surfexp_gateway_hub: { hidden: false } };
	const routes = { surfexp_gateway_link_hub: { from: "nauvis", to: "surfexp_gateway_hub" } };
	for (let i = 1; i <= 4; i++) {
		locations[`surfexp_gateway_${i}`] = { hidden: false };
		routes[`surfexp_gateway_link_${i}`] = { from: "surfexp_gateway_hub", to: `surfexp_gateway_${i}` };
	}
	return { instance: "test-instance", mod: "0.7.9", locations, routes,
		platforms: [{ index: 42, name: "existing", force: "player", location: "nauvis" }] };
}

test("accepts the Gateway with its four coloured portals", () => {
	verifyGatewayMap(snapshot(), { version: "0.7.9" });
});

test("rejects dangling connections even when hidden is true", () => {
	const state = snapshot();
	state.routes.surfexp_gateway_link_extra = { from: "nauvis", to: "surfexp_gateway_1", hidden: true };
	assert.throws(() => verifyGatewayMap(state), /only the expected planets link to the Gateway/);
	const planet = snapshot();
	planet.routes.surfexp_gateway_link_hub_aquilo = { from: "aquilo", to: "surfexp_gateway_hub" };
	assert.throws(() => verifyGatewayMap(planet), /only the expected planets link to the Gateway/);
});

test("rejects a missing Gateway route, a hidden portal, a missing portal and a per-server destination", () => {
	const missing = snapshot();
	delete missing.routes.surfexp_gateway_link_hub;
	assert.throws(() => verifyGatewayMap(missing), /only the expected planets link to the Gateway/);
	const hidden = snapshot();
	hidden.locations.surfexp_gateway_1.hidden = true;
	assert.throws(() => verifyGatewayMap(hidden), /visibility/);
	const removed = snapshot();
	delete removed.locations.surfexp_gateway_4;
	assert.throws(() => verifyGatewayMap(removed), /four coloured portals/);
	const legacy = snapshot();
	legacy.locations.surfexp_gateway_i_11 = { hidden: false };
	assert.throws(() => verifyGatewayMap(legacy), /four coloured portals/);
});

test("evidence recorded before 0.7 is checked against its five planet routes", () => {
	const state = snapshot();
	for (const planet of ["vulcanus", "gleba", "fulgora", "aquilo"]) {
		state.routes[`surfexp_gateway_link_hub_${planet}`] = { from: planet, to: "surfexp_gateway_hub" };
	}
	const hubPlanets = ["nauvis", "vulcanus", "gleba", "fulgora", "aquilo"];
	verifyGatewayMap(state, { hubPlanets });
	assert.throws(() => verifyGatewayMap(state), /only the expected planets link to the Gateway/);
	delete state.routes.surfexp_gateway_link_hub_aquilo;
	assert.throws(() => verifyGatewayMap(state, { hubPlanets }), /only the expected planets link to the Gateway/);
	const before = snapshot();
	for (let i = 1; i <= 4; i++) {
		before.locations[`surfexp_gateway_${i}`].hidden = true;
		delete before.routes[`surfexp_gateway_link_${i}`];
	}
	verifyGatewayMap(before, { hiddenPortals: true });
	assert.throws(() => verifyGatewayMap(before), /visibility/, "hidden numbered gateways are only accepted for older evidence");
	before.routes.surfexp_gateway_link_1 = { from: "surfexp_gateway_hub", to: "surfexp_gateway_1" };
	assert.throws(() => verifyGatewayMap(before, { hiddenPortals: true }), /only the expected planets link to the Gateway/);
});

test("each coloured portal must have one straight route from the Gateway", () => {
	const orphan = snapshot();
	delete orphan.routes.surfexp_gateway_link_2;
	assert.throws(() => verifyGatewayMap(orphan), /surfexp_gateway_2 has one route from the Gateway/);
	const wrongOrigin = snapshot();
	wrongOrigin.routes.surfexp_gateway_link_3.from = "nauvis";
	assert.throws(() => verifyGatewayMap(wrongOrigin), /route origin/);
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
