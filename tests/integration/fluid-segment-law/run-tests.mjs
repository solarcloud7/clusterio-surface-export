#!/usr/bin/env node
// fluid-segment-law — driver for the debug-gated fluid_segment_law_selftest remote.
//
// Invokes the selftest (module/interfaces/remote/fluid-segment-law-selftest.lua) on the gallery
// instance, prints one PASS/FAIL line per fluid-segment law measured live at 2.1.11, and exits 0 iff
// every law re-certified AND teardown was clean AND zero scratch platforms leaked. The selftest owns
// the scratch platform lifecycle; this driver only invokes, parses, and confirms zero leftovers.
//
// game.delete_surface is deferred to end of tick, so the selftest's teardown_clean means "delete
// issued". The authoritative zero-leftover count runs HERE on a later tick (a separate RCON call).
//
// Usage:
//   node tests/integration/fluid-segment-law/run-tests.mjs
//   node tests/integration/fluid-segment-law/run-tests.mjs --instance <name>   (or env SE_LAB_INSTANCE)

import { execFileSync } from "node:child_process";

const CONTROLLER = "surface-export-controller";
const CTL_CONFIG = "/clusterio/tokens/config-control.json";
const SCRATCH_NAME = "fluid-law-selftest-scratch";

const instanceArg = process.argv.indexOf("--instance");
const INSTANCE = instanceArg !== -1 ? process.argv[instanceArg + 1]
	: (process.env.SE_LAB_INSTANCE || "surface-export-lab-gallery");
if (!INSTANCE) throw new Error("--instance needs a value");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function rcon(command) {
	return execFileSync("docker", ["exec", CONTROLLER, "npx", "clusterioctl", "--log-level", "error",
		"instance", "send-rcon", INSTANCE, command, "--config", CTL_CONFIG],
	{ encoding: "utf8", timeout: 300_000, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 }).trim();
}

// JSON-wrapped Lua op (the batch-lifecycle / push-roster convention): pcall, print JSON, throw on
// garbage. The selftest also rcon.print's a human summary BEFORE returning, so take the LAST line.
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

	// Authoritative zero-leftover check on a LATER tick. The RCON round-trips above already advanced
	// several ticks past the deferred delete; a short bounded re-check guards against any lag.
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
