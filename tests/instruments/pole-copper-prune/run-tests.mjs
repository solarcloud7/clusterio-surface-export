#!/usr/bin/env node
// pole-copper-prune — which wire ORIGINS the destination copper prune can actually reach
//
// requires: one instance up with the plugin loaded (it builds and deletes its own scratch platform)
// produces: the live defines.wire_origin membership, the origin the engine's own auto-connect
//           writes, whether an origin-less disconnect_from can remove a script-origin wire, whether
//           the export capture records a wire's origin, and Deserializer.prune_pole_copper's own
//           verdict on foreign vs payload-carried wires at player and script origin, real and ghost
// does not: transfer anything (no payload crosses an instance here — the prune is called directly
//           on a hand-built entities_to_create/entity_map), assert any config attribute survives a
//           transfer, or measure a producer of script-origin copper in production (none exists with
//           this mod-set; the rows arm the wire themselves); arm a GHOST connector at an origin
//           holding no wire — that one cell of the origin x connector-kind cross product is not
//           measured, only its real-pole twin is, and a throw there would be contained by
//           prune_pole_copper's per-pole pcall and named by its THREW line

import { execFileSync } from "node:child_process";

const CONTROLLER = "surface-export-controller";
const CTL_CONFIG = "/clusterio/tokens/config-control.json";
const SCRATCH_NAME = "pole-copper-prune-selftest-scratch";

const instanceArg = process.argv.indexOf("--instance");
const INSTANCE = instanceArg !== -1 ? process.argv[instanceArg + 1]
	: (process.env.SE_LAB_INSTANCE || "clusterio-host-1-instance-1");
if (!INSTANCE) throw new Error("--instance needs a value");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function rcon(command) {
	return execFileSync("docker", ["exec", CONTROLLER, "npx", "clusterioctl", "--log-level", "error",
		"instance", "send-rcon", INSTANCE, command, "--config", CTL_CONFIG],
	{ encoding: "utf8", timeout: 300_000, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 }).trim();
}

function lua(body) {
	const command = `/sc local ok,result=pcall(function() ${body} end); ` +
		`if ok then rcon.print(helpers.table_to_json(result)) else rcon.print(helpers.table_to_json({ok=false,error=tostring(result)})) end`;
	const raw = rcon(command).split(/\r?\n/).map(l => l.trim()).filter(Boolean).at(-1) || "";
	try { return JSON.parse(raw); }
	catch (error) { throw new Error(`Invalid Lua JSON from ${INSTANCE}: ${raw}\n${error.message}`); }
}

function countLeftovers() {
	const res = lua(`local n=0; for _,p in pairs(game.forces.player.platforms) do ` +
		`if p.valid and p.name=='${SCRATCH_NAME}' then n=n+1 end end; return {ok=true,leftovers=n}`);
	return typeof res.leftovers === "number" ? res.leftovers : -1;
}

async function main() {
	console.log(`pole-copper-prune: invoking pole_copper_prune_selftest on ${INSTANCE} ...`);
	lua(`remote.call('surface_export','configure',{debug_mode=true}); return {ok=true}`);
	const result = lua(`return remote.call('surface_export','pole_copper_prune_selftest')`);

	if (result.err) {
		console.error(`selftest refused: ${result.err} (enable debug_mode on ${INSTANCE})`);
		process.exit(1);
	}

	const rows = result.rows || [];
	let failed = 0;
	for (const row of rows) {
		if (!row.ok) failed++;
		console.log(`  ${row.ok ? "PASS" : "FAIL"}  ${row.name}: ${row.detail}`);
	}
	console.log(`  teardown_clean=${result.teardown_clean}`);

	let leftovers = countLeftovers();
	for (let attempt = 0; attempt < 3 && leftovers > 0; attempt++) {
		await sleep(2000);
		leftovers = countLeftovers();
	}
	console.log(`  leftover scratch platforms=${leftovers}`);

	const ok = result.ok === true && result.teardown_clean === true && leftovers === 0 && rows.length > 0;
	console.log(`\n=== pole-copper-prune: ${ok ? "ALL PASS" : "FAIL"} ` +
		`(${rows.length - failed}/${rows.length} rows, teardown_clean=${result.teardown_clean}, leftovers=${leftovers}) ===`);
	process.exit(ok ? 0 : 1);
}

await main();
