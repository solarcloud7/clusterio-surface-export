#!/usr/bin/env node
// requires: a running seeded instance, Docker, and controller access
// produces: gateway/platform JSON; optional map, version, and before/after identity checks
// does not: restart games, change settings, create fixtures, or prove client rendering
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { seededInstances } from "../shared/seeded-instances.mjs";

const HUB = "surfexp_gateway_hub";
const PORTALS = [1, 2, 3, 4].map(i => `surfexp_gateway_${i}`);
const portalRoute = name => name.replace("surfexp_gateway_", "surfexp_gateway_link_");
const hubRoute = planet => `surfexp_gateway_link_hub${planet === "nauvis" ? "" : `_${planet}`}`;
export function verifyGatewayMap(state, { version, baseline, hubPlanets = ["nauvis"], hiddenPortals = false } = {}) {
	if (version) assert.equal(state.mod, version, "loaded mod version");
	const portalRoutes = hiddenPortals ? [] : PORTALS.map(portalRoute);
	const fixedRoutes = Object.keys(state.routes).filter(name => !portalRoutes.includes(name));
	assert.deepEqual(fixedRoutes.sort(), hubPlanets.map(hubRoute).sort(),
		"only the expected planets link to the Gateway; hidden flags do not remove map lines");
	for (const planet of hubPlanets) {
		assert.equal(state.routes[hubRoute(planet)].from, planet, `${hubRoute(planet)} origin`);
		assert.equal(state.routes[hubRoute(planet)].to, HUB, `${hubRoute(planet)} destination`);
	}
	assert.deepEqual(Object.keys(state.locations).sort(), [HUB, ...PORTALS].sort(), "the Gateway and its four coloured portals");
	assert.equal(state.locations[HUB].hidden, false, `${HUB} visibility`);
	for (const name of PORTALS) assert.equal(state.locations[name].hidden, hiddenPortals, `${name} visibility`);
	for (const name of hiddenPortals ? [] : PORTALS) {
		const route = state.routes[portalRoute(name)];
		assert.ok(route, `${name} has one route from the Gateway`);
		assert.equal(route.from, HUB, `${name} route origin`);
		assert.equal(route.to, name, `${name} route destination`);
	}
	if (baseline) {
		assert.equal(state.instance, baseline.instance, "baseline belongs to another instance");
		assert.deepEqual(state.platforms, baseline.platforms, "platform identities or locations changed");
	}
}

export const gatewayMapObserver = `
local locations,routes,platforms={},{},{}
for name,p in pairs(prototypes.space_location) do
  if name:find('surfexp_gateway_',1,true)==1 then
    locations[name]={hidden=p.hidden,distance=p.distance,orientation=p.orientation,magnitude=p.magnitude}
  end
end
for name,p in pairs(prototypes.space_connection) do
  if name:find('surfexp_gateway_link_',1,true)==1 then routes[name]={from=p.from.name,to=p.to.name,hidden=p.hidden} end
end
for _,force in pairs(game.forces) do for _,p in pairs(force.platforms) do
  platforms[#platforms+1]={force=force.name,index=p.index,name=p.name,
    location=p.space_location and p.space_location.name,connection=p.space_connection and p.space_connection.name}
end end
table.sort(platforms,function(a,b) return a.index<b.index end)
return {mod=script.active_mods.surfexp_gateways,locations=locations,routes=routes,platforms=platforms}
`;

function main() {
	const { values } = parseArgs({ options: {
		host: { type: "string" }, output: { type: "string" }, baseline: { type: "string" },
		"expect-version": { type: "string" }, verify: { type: "boolean" }, help: { type: "boolean" },
	} });
	if (values.help) {
		console.log("node tools/surface-export/check-gateway-map.mjs --host <number> [--output <json>] [--verify] [--expect-version <version>] [--baseline <json>]\nRead-only. Version/baseline options also enable verification. Client appearance still needs a screenshot.");
		return;
	}
	const candidates = seededInstances().filter(i => String(i.hostNumber) === values.host);
	assert.equal(candidates.length, 1, "--host must select exactly one seeded instance");
	const instance = candidates[0].instance;
	const command = `/sc local ok,result=pcall(function() ${gatewayMapObserver} end); rcon.print(helpers.table_to_json(ok and result or {error=tostring(result)}))`;
	const raw = execFileSync("docker", ["exec", "surface-export-controller", "npx", "clusterioctl",
		"--config", "/clusterio/tokens/config-control.json", "--log-level", "error",
		"instance", "send-rcon", instance, command], { encoding: "utf8", timeout: 60_000 });
	const state = JSON.parse(raw.trim().split(/\r?\n/).at(-1));
	assert.ok(!state.error, state.error);
	state.instance = instance;
	// Factorio encodes an empty Lua array as {}.
	state.platforms = Object.values(state.platforms);
	if (values.output) writeFileSync(values.output, JSON.stringify(state, null, 2) + "\n", { flag: "wx" });
	console.log(JSON.stringify(state, null, 2));
	if (values.verify || values["expect-version"] || values.baseline) {
		verifyGatewayMap(state, { version: values["expect-version"],
			baseline: values.baseline ? JSON.parse(readFileSync(values.baseline, "utf8")) : undefined });
		console.log("PASS: gateway prototypes and requested baseline checks. Client rendering not checked.");
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
