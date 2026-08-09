#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const CONTROLLER = "surface-export-controller";
const CTL_CONFIG = "/clusterio/tokens/config-control.json";
const SCRATCH_NAME = "fluid-law-selftest-scratch";

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
	console.log(`fluid-segment-law: invoking fluid_segment_law_selftest on ${INSTANCE} ...`);
	lua(`remote.call('surface_export','configure',{debug_mode=true}); return {ok=true}`);
	const result = lua(`return remote.call('surface_export','fluid_segment_law_selftest')`);

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

	const ok = result.ok === true && result.teardown_clean === true && leftovers === 0;
	console.log(`\n=== fluid-segment-law: ${ok ? "ALL PASS" : "FAIL"} ` +
		`(${rows.length - failed}/${rows.length} rows, teardown_clean=${result.teardown_clean}, leftovers=${leftovers}) ===`);
	process.exit(ok ? 0 : 1);
}

await main();
