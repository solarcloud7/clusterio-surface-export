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
// Identity note: the lock is created without a transfer_job_id, and the delete passes nil — the
// gate then degrades to the surface.index check by design (lua-interface.ts documents this).
//
// CLEANUP IS UNCONDITIONAL (review finding on PR #157: the first version leaked on EVERY failure
// path — an ERROR from the delete left the probe platform LOCKED, an rconJson throw left
// everything, and the fixed probe name then made every later run permanently red). The finally
// block sweeps ALL platforms wearing this run's probe name (best-effort unlock first, so a locked
// leftover is still removable) and destroys every Nauvis character not in the pre-test baseline —
// which also covers the stale-second-body case. The probe name is UNIQUE PER RUN, and the
// `evac-coverage-probe` prefix is in cleanup-test-surfaces.ps1's sweep list as the backstop.

import { execFileSync } from "node:child_process";

const CONTROLLER = "surface-export-controller";
const CTL_CONFIG = "/clusterio/tokens/config-control.json";
const INSTANCE = process.env.SE_LAB_INSTANCE || "clusterio-host-1-instance-1";
const PROBE = `evac-coverage-probe-${Date.now().toString(36)}`;

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

console.log(`=== evacuation-coverage: a body aboard survives the source-delete chokepoint (${PROBE}) ===`);

// Baseline: every UNATTACHED character body on Nauvis BEFORE the test (never assume zero).
// Unattached-only, consistently with the sweep's player guard: attached characters are connected
// players — outside this test's accounting in both directions.
const baseline = rconJson(
	`(function() local t={} for _,c in pairs(game.surfaces['nauvis'].find_entities_filtered{type='character'}) do if c.player == nil then t[#t+1]=c.unit_number end end return {units=t} end)()`,
);
const baselineUnits = new Set(asArray(baseline.units));
// A Lua SET literal of the baseline, for the finally sweep ({} when empty).
const baselineLuaSet = baselineUnits.size
	? `{${[...baselineUnits].map(u => `[${u}]=true`).join(",")}}`
	: "{}";

let probeIndex = null;
try {
	// Setup: throwaway platform + hub, one unattached character body aboard.
	const setup = rconJson(
		`(function() local p=game.forces.player.create_space_platform{name='${PROBE}', planet='nauvis', starter_pack='space-platform-starter-pack'} `
		+ `p.apply_starter_pack() `
		+ `local body=p.surface.create_entity{name='character', position={2,3}, force='player'} `
		+ `return {index=p.index, body_ok=(body~=nil and body.valid), chars_aboard=p.surface.count_entities_filtered{type='character'}} end)()`,
	);
	probeIndex = setup.index ?? null;
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
} finally {
	// Unconditional sweep: every probe-named platform (unlock best-effort first, so even a locked
	// leftover is removable) and every non-baseline character on Nauvis. Its own try/catch so a
	// sweep failure is REPORTED without masking the primary failure above.
	try {
		const swept = rconJson(
			`(function() local baseline=${baselineLuaSet} local plats=0 local refusals={} `
			+ `for _,q in pairs(game.forces.player.platforms) do if q.name=='${PROBE}' then `
			// unlock_platform reports a SOFT refusal via return values, not a throw — capture both
			// channels and surface them (delta-pass finding: a bare pcall read a refusal as success,
			// then the raw surface delete orphaned the lock record).
			+ `local okc, uok, ureason = pcall(remote.call, 'surface_export', 'unlock_platform', q.index) `
			+ `if not okc or uok == false then refusals[#refusals+1] = tostring(ureason or uok) end `
			+ `if q.surface and q.surface.valid then game.delete_surface(q.surface) plats=plats+1 end end end `
			// PLAYER GUARD (delta-pass finding, the severe one): destroy ONLY unattached bodies. A
			// character with c.player attached is a CONNECTED PLAYER on this always-up shared
			// cluster — never sweepable, baseline or not. The probe's evacuee is always unattached.
			+ `local chars=0 for _,c in pairs(game.surfaces['nauvis'].find_entities_filtered{type='character'}) do `
			+ `if (not baseline[c.unit_number]) and c.player == nil then c.destroy() chars=chars+1 end end `
			+ `local lock_residue = false `
			+ (probeIndex !== null
				? `if storage.locked_platforms and storage.locked_platforms[${probeIndex}] ~= nil then lock_residue = true end `
				: "")
			+ `return {platforms=plats, characters=chars, refusals=refusals, lock_residue=lock_residue} end)()`,
		);
		// The normal green path expects: platform already deleted by the chokepoint (0 swept), the
		// one evacuated body removed here (1 character). Anything else is visible in the line below.
		console.log(`  cleanup: swept ${swept.platforms} leftover platform(s), ${swept.characters} non-baseline character(s)`);
		for (const refusal of asArray(swept.refusals)) {
			failed++;
			console.error(`  FAIL unlock refused during sweep: ${refusal} — a lock record may be orphaned`);
		}
		check(swept.lock_residue === false,
			"zero leftovers: no storage.locked_platforms residue for the probe index",
			"a lock record outlived its platform — persistent storage.* records are leftovers too");
		const remaining = rconJson(
			`(function() local unattached=0 for _,c in pairs(game.surfaces['nauvis'].find_entities_filtered{type='character'}) do `
			+ `if c.player == nil then unattached = unattached + 1 end end return {chars=unattached} end)()`,
		);
		// Compare UNATTACHED counts only: a player connecting mid-run adds an attached character that
		// is neither ours to count nor ours to remove.
		const baselineUnattached = baselineUnits.size;
		check(remaining.chars <= baselineUnattached, "zero leftovers: no unattached character added to Nauvis",
			`baseline=${baselineUnattached} now=${remaining.chars}`);
	} catch (sweepErr) {
		failed++;
		console.error(`  FAIL cleanup sweep threw: ${sweepErr && sweepErr.message ? sweepErr.message : sweepErr}`);
		console.error(`  hand-clean with: tools/tests/cleanup-test-surfaces.ps1 (probe prefix evac-coverage-probe is in its sweep list)`);
	}
}

if (failed) {
	console.log(`=== evacuation-coverage: ${failed} FAILURE(S) ===`);
	process.exit(1);
}
console.log("=== evacuation-coverage: ALL PASS ===");
