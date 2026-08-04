#!/usr/bin/env node
// Evacuation coverage — the branch CLAUDE.md flagged as UNCOVERED since the passenger-evacuate
// runner was retired (2026-07-27): every transfer executes the source-delete chokepoint, but no
// standing test put a body aboard first.
//
// This drives the REAL chokepoint (`delete_platform_for_transfer` — the sole production
// source-delete path: identity gate → unlock → Gateway.evacuate_passengers → delete) against a
// throwaway platform carrying an unattached CHARACTER body, and asserts the body ARRIVES on
// Nauvis. The counterfactual is MEASURED, not assumed: game.delete_surface destroys aboard bodies
// with the surface (raw-engine probe, 2026-08-03 — that measurement is why evacuation exists), so
// a +1 Nauvis character count is evidence the protective route ran, not luck.
//
// Identity note: the lock is created without a transfer_job_id, and the delete passes nil —
// the gate then degrades to the surface.index check by design (lua-interface.ts documents this).
// Zero leftovers: the platform is deleted by the test itself; the evacuated body is identified by
// unit_number against a pre-test baseline (never "all characters") and destroyed at the end.

import { execFileSync } from "node:child_process";

const CONTROLLER = "surface-export-controller";
const CTL_CONFIG = "/clusterio/tokens/config-control.json";
const INSTANCE = process.env.SE_LAB_INSTANCE || "clusterio-host-1-instance-1";
const PROBE = "evac-coverage-probe";

function rcon(luaBody) {
	const cmd = `npx clusterioctl --config ${CTL_CONFIG} --log-level error instance send-rcon `
		+ `"${INSTANCE}" "/sc ${luaBody.replace(/"/g, '\\"')}"`;
	return execFileSync("docker", ["exec", CONTROLLER, "sh", "-c", cmd], { encoding: "utf8" }).trim();
}
function rconJson(luaExpr) {
	const out = rcon(`rcon.print(helpers.table_to_json(${luaExpr}))`);
	const line = out.split("\n").map(l => l.trim()).filter(Boolean).at(-1);
	return JSON.parse(line);
}

// An EMPTY Lua table serializes as `{}` (object), a populated array-like one as `[...]` — the
// numeric-key coercion class. Normalize both shapes before iterating.
const asArray = (v) => (Array.isArray(v) ? v : Object.values(v || {}));

let failed = 0;
const check = (ok, label, detail = "") => {
	console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
	if (!ok) failed++;
};

console.log("=== evacuation-coverage: a body aboard survives the source-delete chokepoint ===");

// Baseline: every character unit_number on Nauvis BEFORE the test (never assume zero).
const baseline = rconJson(
	`(function() local t={} for _,c in pairs(game.surfaces['nauvis'].find_entities_filtered{type='character'}) do t[#t+1]=c.unit_number end return {units=t} end)()`,
);
const baselineUnits = new Set(asArray(baseline.units));

// Setup: throwaway platform + hub, one unattached character body aboard.
const setup = rconJson(
	`(function() local p=game.forces.player.create_space_platform{name='${PROBE}', planet='nauvis', starter_pack='space-platform-starter-pack'} `
	+ `p.apply_starter_pack() `
	+ `local body=p.surface.create_entity{name='character', position={2,3}, force='player'} `
	+ `return {index=p.index, body_ok=(body~=nil and body.valid), chars_aboard=p.surface.count_entities_filtered{type='character'}} end)()`,
);
check(setup.body_ok === true && setup.chars_aboard === 1, "probe platform carries one character body");

// Drive the REAL chokepoint: production lock, then the sole source-delete path.
const driven = rconJson(
	`(function() local ok, err = remote.call('surface_export', 'lock_platform_for_transfer', ${setup.index}, 'player') `
	+ `if not ok then return {locked=false, err=tostring(err)} end `
	+ `local result = remote.call('surface_export', 'delete_platform_for_transfer', ${setup.index}, '${PROBE}', 'player', nil) `
	+ `return {locked=true, result=result} end)()`,
);
check(driven.locked === true, "production transfer lock acquired", driven.err);
check(driven.result === "SUCCESS", "delete chokepoint returned SUCCESS", String(driven.result));

// Next execution (delete_surface is deferred to end of tick): platform gone, body ARRIVED.
const after = rconJson(
	`(function() local present=false for _,q in pairs(game.forces.player.platforms) do if q.name=='${PROBE}' then present=true end end `
	+ `local units={} for _,c in pairs(game.surfaces['nauvis'].find_entities_filtered{type='character'}) do units[#units+1]=c.unit_number end `
	+ `return {platform_present=present, nauvis_units=units} end)()`,
);
check(after.platform_present === false, "probe platform fully deleted");
const arrived = asArray(after.nauvis_units).filter(u => !baselineUnits.has(u));
check(arrived.length === 1,
	"the body was EVACUATED to Nauvis (the engine destroys un-evacuated bodies with the surface — measured)",
	`new characters on nauvis: ${arrived.length}`);

// Zero leftovers: remove exactly the evacuated body, verify the baseline is restored.
if (arrived.length > 0) {
	const cleaned = rconJson(
		`(function() local removed=0 for _,c in pairs(game.surfaces['nauvis'].find_entities_filtered{type='character'}) do `
		+ `if c.unit_number == ${arrived[0]} then c.destroy() removed=removed+1 end end `
		+ `local remaining=game.surfaces['nauvis'].count_entities_filtered{type='character'} `
		+ `return {removed=removed, remaining=remaining} end)()`,
	);
	check(cleaned.removed === arrived.length && cleaned.remaining === baselineUnits.size,
		"zero leftovers: evacuated body removed, baseline restored",
		JSON.stringify(cleaned));
}

if (failed) {
	console.log(`=== evacuation-coverage: ${failed} FAILURE(S) ===`);
	process.exit(1);
}
console.log("=== evacuation-coverage: ALL PASS ===");
