#!/usr/bin/env node
// requires: a running seeded instance, Docker, and controller access
// produces: gateway/platform JSON; optional layout, version, and before/after identity checks
// does not: restart games, change settings, create fixtures, or prove client rendering
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { seededInstances } from "../shared/seeded-instances.mjs";

const PLANETS = ["nauvis", "vulcanus", "gleba", "fulgora", "aquilo"];
const HUB = "surfexp_gateway_hub";
export function verifyGatewayMap(state, { version, baseline } = {}) {
	assert.ok(["one_gate", "multi"].includes(state.layout), "unknown gateway layout");
	if (version) assert.equal(state.mod, version, "loaded mod version");
	const expected = state.layout === "one_gate"
		? PLANETS.map(p => [`surfexp_gateway_link_hub${p === "nauvis" ? "" : `_${p}`}`, p, HUB])
		: [1, 2, 3, 4].map(i => [`surfexp_gateway_link_${i}`, "nauvis", `surfexp_gateway_${i}`]);
	assert.deepEqual(Object.keys(state.routes).sort(), expected.map(r => r[0]).sort(),
		"inactive routes must be absent; hidden flags do not remove map lines");
	assert.deepEqual(Object.keys(state.locations).sort(), [HUB, ...[1, 2, 3, 4].map(i => `surfexp_gateway_${i}`)].sort());
	const active = new Set(expected.map(r => r[2]));
	for (const [name, location] of Object.entries(state.locations)) {
		assert.equal(location.hidden, !active.has(name), `${name} visibility`);
	}
	for (const [name, from, to] of expected) {
		assert.equal(state.routes[name].from, from, `${name} origin`);
		assert.equal(state.routes[name].to, to, `${name} destination`);
	}
	if (baseline) {
		assert.equal(state.instance, baseline.instance, "baseline belongs to another instance");
		assert.deepEqual(state.platforms, baseline.platforms, "platform identities or locations changed");
	}
}

const observer = `
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
return {mod=script.active_mods.surfexp_gateways,layout=settings.startup['surfexp-gateway-layout'].value,
  locations=locations,routes=routes,platforms=platforms}
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
	const command = `/sc local ok,result=pcall(function() ${observer} end); rcon.print(helpers.table_to_json(ok and result or {error=tostring(result)}))`;
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
