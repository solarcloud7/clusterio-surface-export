import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyGatewayMap } from "../../tools/surface-export/check-gateway-map.mjs";

function snapshot(destinations = []) {
	const locations = { surfexp_gateway_hub: { hidden: false } };
	for (let i = 1; i <= 4; i++) locations[`surfexp_gateway_${i}`] = { hidden: true };
	const routes = { surfexp_gateway_link_hub: { from: "nauvis", to: "surfexp_gateway_hub" } };
	for (const id of destinations) {
		locations[`surfexp_gateway_i_${id}`] = { hidden: false };
		routes[`surfexp_gateway_link_i_${id}`] = { from: "surfexp_gateway_hub", to: `surfexp_gateway_i_${id}` };
	}
	return { instance: "test-instance", mod: "0.7.8", locations, routes,
		platforms: [{ index: 42, name: "existing", force: "player", location: "nauvis" }] };
}

test("accepts the Gateway with and without server destinations", () => {
	verifyGatewayMap(snapshot(), { version: "0.7.8" });
	verifyGatewayMap(snapshot([11, 22]), { version: "0.7.8" });
});

test("rejects dangling connections even when hidden is true", () => {
	const state = snapshot();
	state.routes.surfexp_gateway_link_1 = { from: "nauvis", to: "surfexp_gateway_1", hidden: true };
	assert.throws(() => verifyGatewayMap(state), /only the expected planets link to the Gateway/);
	const planet = snapshot();
	planet.routes.surfexp_gateway_link_hub_aquilo = { from: "aquilo", to: "surfexp_gateway_hub" };
	assert.throws(() => verifyGatewayMap(planet), /only the expected planets link to the Gateway/);
});

test("rejects a missing Gateway route and incorrect location visibility", () => {
	const missing = snapshot();
	delete missing.routes.surfexp_gateway_link_hub;
	assert.throws(() => verifyGatewayMap(missing), /only the expected planets link to the Gateway/);
	const visible = snapshot();
	visible.locations.surfexp_gateway_1.hidden = false;
	assert.throws(() => verifyGatewayMap(visible), /visibility/);
	const removed = snapshot();
	delete removed.locations.surfexp_gateway_4;
	assert.throws(() => verifyGatewayMap(removed));
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
});

test("server destinations must each have one route from the Gateway", () => {
	const orphan = snapshot([11]);
	delete orphan.routes.surfexp_gateway_link_i_11;
	assert.throws(() => verifyGatewayMap(orphan), /each server destination has one route/);
	const wrongOrigin = snapshot([11]);
	wrongOrigin.routes.surfexp_gateway_link_i_11.from = "nauvis";
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
