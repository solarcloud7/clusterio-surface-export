#!/usr/bin/env node
// platform-paused-restore — a transferred platform must arrive in the paused state its SOURCE carried
//
// requires: the cluster up, host-1 able to export, host-2 able to receive, debug_mode togglable on
//           host-2 via the configure remote (this runner ARMS it and restores the prior value, because
//           the gate verdict is read from a debug_import_result file that is never written with it off)
// produces: per-arm fresh default + SOURCE arming readback, the destination gate verdict and its
//           recorded sourcePaused/sourcePausedApplied fields, TWO destination physical reads of
//           platform.paused and platform.state (at arrival and after a settling delay) for a PAUSED
//           source arm and an UNPAUSED source arm (control), and a REPORT-ONLY power reading of a
//           solar-fed lamp on each arrived platform
// does not: park at a gateway (a park owns the terminal pause by its own contract — that arm is
//           gateway-park-proxies, which asserts an UNPAUSED source arrives PAUSED when parked);
//           assert item/fluid fidelity (the gate does that); touch the protected fixtures (each arm
//           builds and sweeps its own throwaway platform); GRADE the power reading — it is printed
//           for both arms with the unpaused arm as its own control, and a lamp that reads unpowered
//           in BOTH arms means the probe said nothing, not that pause de-powers; exercise latch
//           re-arm — no decider-combinator is placed, so the settling read covers the
//           post-completion path (source delete, unlock, subscription emit), not LatchRearm

import { execFileSync } from "node:child_process";

const CONTROLLER = "surface-export-controller";
const CTL_CONFIG = "/clusterio/tokens/config-control.json";
const SRC_INSTANCE = "clusterio-host-1-instance-1";
const DST_INSTANCE = "clusterio-host-2-instance-1";
const DST_CONTAINER = "surface-export-host-2";
const DST_SCRIPT_OUTPUT = "/clusterio/data/instances/clusterio-host-2-instance-1/script-output";
const RUN_TAG = Date.now().toString(36);
const ARRIVAL_WAIT_MS = 180_000;
const SETTLE_MS = 15_000;

const ARMS = [
	{ id: "paused", armed: true, label: "a PAUSED source" },
	{ id: "running", armed: false, label: "an UNPAUSED source (control)" },
];

function rcon(instance, luaBody) {
	const cmd = `npx clusterioctl --config ${CTL_CONFIG} --log-level error instance send-rcon `
		+ `"${instance}" "/sc ${luaBody.replace(/"/g, '\\"')}"`;
	return execFileSync("docker", ["exec", CONTROLLER, "sh", "-c", cmd], { encoding: "utf8" }).trim();
}
function rconJson(instance, luaExpr) {
	const out = rcon(instance, `rcon.print(helpers.table_to_json(${luaExpr}))`);
	const line = out.split("\n").map(l => l.trim()).filter(Boolean).at(-1);
	try {
		return JSON.parse(line);
	} catch (parseErr) {
		throw new Error(`rconJson: expected JSON, got:\n${out}\n(parse error: ${parseErr.message})`);
	}
}
function rawCommand(instance, command) {
	const cmd = `npx clusterioctl --config ${CTL_CONFIG} --log-level error instance send-rcon `
		+ `"${instance}" "${command.replace(/"/g, '\\"')}"`;
	return execFileSync("docker", ["exec", CONTROLLER, "sh", "-c", cmd], { encoding: "utf8" }).trim();
}
function resolveInstanceId(name) {
	const out = execFileSync("docker", ["exec", CONTROLLER, "sh", "-c",
		`npx clusterioctl --config ${CTL_CONFIG} --log-level error instance list`], { encoding: "utf8" });
	const line = out.split("\n").find(l => l.includes(name));
	const m = line && line.match(/\|\s*(\d+)\s*\|/);
	if (!m) throw new Error(`could not resolve instance id for ${name}`);
	return Number(m[1]);
}
function readDestImportResult() {
	const file = execFileSync("docker", ["exec", DST_CONTAINER, "sh", "-c",
		`ls -t ${DST_SCRIPT_OUTPUT}/debug_import_result_*.json 2>/dev/null | head -1`],
	{ encoding: "utf8" }).trim();
	if (!file) return null;
	const body = execFileSync("docker", ["exec", DST_CONTAINER, "sh", "-c", `cat '${file}'`],
		{ encoding: "utf8" });
	return JSON.parse(body);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failed = 0;
const check = (ok, label, detail = "") => {
	console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
	if (!ok) failed++;
};
const note = (text) => console.log(`  NOTE  ${text}`);

const platformStateLua = name =>
	`(function() for _,q in pairs(game.forces.player.platforms) do if q.name=='${name}' then `
	+ `return {present=true, paused=(q.paused==true), state=q.state, `
	+ `state_paused=(q.state==defines.space_platform_state.paused)} end end `
	+ `return {present=false} end)()`;

const powerProbeLua = name =>
	`(function() for _,q in pairs(game.forces.player.platforms) do if q.name=='${name}' then `
	+ `local names={} for k,v in pairs(defines.entity_status) do names[v]=k end `
	+ `local lamps=q.surface.find_entities_filtered{name='small-lamp'} `
	+ `local lamp=lamps and lamps[1] `
	+ `if not (lamp and lamp.valid) then return {probe='no lamp on the arrived platform'} end `
	+ `return {probe='read', status=names[lamp.status] or tostring(lamp.status), `
	+ `energy=string.format('%.2f', lamp.energy)} end end `
	+ `return {probe='platform not found'} end)()`;

function sweep(name) {
	for (const instance of [SRC_INSTANCE, DST_INSTANCE]) {
		try {
			const swept = rconJson(instance,
				`(function() local n=0 for _,q in pairs(game.forces.player.platforms) do `
				+ `if q.name=='${name}' then `
				+ `pcall(remote.call, 'surface_export', 'unlock_platform', q.index) `
				+ `if q.surface and q.surface.valid then game.delete_surface(q.surface) n=n+1 end `
				+ `end end return {swept=n} end)()`,
			);
			if (swept.swept > 0) console.log(`  cleanup(${instance}): swept ${swept.swept} probe platform(s)`);
		} catch (sweepErr) {
			failed++;
			console.error(`  FAIL cleanup sweep on ${instance} threw: `
				+ `${sweepErr && sweepErr.message ? sweepErr.message : sweepErr}`);
		}
	}
}

async function runArm(arm, dstId) {
	const probe = `pausedrs-${arm.id}-${RUN_TAG}`;
	console.log(`\n--- arm '${arm.id}': ${arm.label} must arrive paused=${arm.armed} (${probe}) ---`);
	try {
		const setup = rconJson(SRC_INSTANCE,
			`(function() local force=game.forces.player `
			+ `local p=force.create_space_platform{name='${probe}', planet='nauvis', `
			+ `starter_pack='space-platform-starter-pack'} `
			+ `p.apply_starter_pack() `
			+ `local s=p.surface `
			+ `local tiles={} `
			+ `for x=4,12 do for y=0,6 do `
			+ `tiles[#tiles+1]={name='space-platform-foundation', position={x,y}} end end `
			+ `s.set_tiles(tiles) `
			+ `local rig={} `
			+ `for _,spec in ipairs({{'solar-panel',6.5,2.5},{'small-electric-pole',9.5,2.5},`
			+ `{'small-lamp',11.5,2.5}}) do `
			+ `local ok,e=pcall(function() return s.create_entity{name=spec[1], `
			+ `position={spec[2],spec[3]}, force=force} end) `
			+ `rig[#rig+1]=spec[1]..'='..tostring(ok and e~=nil and e.valid) end `
			+ `local fresh=(p.paused==true) `
			+ `p.paused=${arm.armed} `
			+ `return {index=p.index, fresh_paused=fresh, armed_paused=(p.paused==true), `
			+ `armed_state_paused=(p.state==defines.space_platform_state.paused), `
			+ `rig=table.concat(rig, ' ')} end)()`,
		);
		console.log(`  source: index=${setup.index} fresh default paused=${setup.fresh_paused} `
			+ `-> armed paused=${setup.armed_paused} (state_paused=${setup.armed_state_paused})`);
		note(`power-probe rig placed on the source: ${setup.rig}`);
		check(setup.armed_paused === arm.armed,
			`ARMED: the source platform reads back paused=${arm.armed} before any export`,
			`source reads paused=${setup.armed_paused}`);
		if (setup.armed_paused !== arm.armed) return;

		const trigger = rawCommand(SRC_INSTANCE, `/transfer-platform ${setup.index} ${dstId}`);
		check(/Export queued/.test(trigger) && !/Transfer failed/.test(trigger),
			"the trigger accepted the transfer",
			trigger.split("\n").filter(Boolean).slice(-2).join(" / "));

		let arrived = null;
		const deadline = Date.now() + ARRIVAL_WAIT_MS;
		while (Date.now() < deadline) {
			await sleep(3000);
			const dst = rconJson(DST_INSTANCE, platformStateLua(probe));
			if (!dst.present) continue;
			const src = rconJson(SRC_INSTANCE, platformStateLua(probe));
			if (!src.present) { arrived = dst; break; }
		}
		check(arrived !== null,
			"TERMINAL: destination present AND source deleted (the 2PC completed) within "
			+ `${ARRIVAL_WAIT_MS / 1000}s`);
		if (!arrived) return;

		const verdict = readDestImportResult();
		check(verdict !== null && verdict.platform_name === probe && verdict.validation_success === true,
			"the destination's debug_import_result reports validation_success for THIS platform",
			verdict
				? `newest debug_import_result is platform=${verdict.platform_name} `
					+ `success=${verdict.validation_success} — a STALE file here means debug_mode was not `
					+ "armed on the destination, so no result was written for this transfer"
				: "no debug_import_result found at all — debug_mode is off on the destination, so the "
					+ "gate verdict could not be read");

		const recorded = (verdict && verdict.validation_result) || {};
		check(recorded.sourcePaused === arm.armed && recorded.sourcePausedApplied === true,
			`the verdict records the captured pause it applied (sourcePaused=${arm.armed}, applied)`,
			`verdict carries sourcePaused=${String(recorded.sourcePaused)} `
			+ `sourcePausedApplied=${String(recorded.sourcePausedApplied)}`);

		const atArrival = rconJson(DST_INSTANCE, platformStateLua(probe));
		const powerAtArrival = rconJson(DST_INSTANCE, powerProbeLua(probe));
		await sleep(SETTLE_MS);
		const settled = rconJson(DST_INSTANCE, platformStateLua(probe));
		const powerSettled = rconJson(DST_INSTANCE, powerProbeLua(probe));
		console.log(`  destination: at arrival paused=${atArrival.paused} state=${atArrival.state}; `
			+ `after ${SETTLE_MS / 1000}s paused=${settled.paused} state=${settled.state}`);
		note(`POWER on the arrived platform (report only, not graded): at arrival `
			+ `${JSON.stringify(powerAtArrival)}; after ${SETTLE_MS / 1000}s ${JSON.stringify(powerSettled)}`);

		check(atArrival.paused === arm.armed && atArrival.state_paused === arm.armed,
			`the destination platform arrives paused=${arm.armed} — the state its source carried`,
			`arrival read paused=${atArrival.paused} state=${atArrival.state}`);
		check(settled.present === true && settled.paused === arm.armed
			&& settled.state_paused === arm.armed,
			`the arrived pause state SURVIVES ${SETTLE_MS / 1000}s of post-completion work`,
			`settled read present=${settled.present} paused=${settled.paused} state=${settled.state}`);
	} finally {
		sweep(probe);
	}
}

console.log("=== platform-paused-restore: platform.paused must survive a transfer, both directions "
	+ `(${RUN_TAG}) ===`);
const dstId = resolveInstanceId(DST_INSTANCE);

// Read BEFORE anything writes it: a later arming failure must not restore a value this run invented.
let prevDebug = null;
try {
	prevDebug = rconJson(DST_INSTANCE,
		"(function() return {debug=(storage.surface_export_config "
		+ "and storage.surface_export_config.debug_mode)==true} end)()").debug === true;
	rcon(DST_INSTANCE, "remote.call('surface_export', 'configure', { debug_mode = true })");
	console.log(`  destination debug_mode armed (was ${prevDebug}) — the gate verdict is read from a `
		+ "debug_import_result file that is only written while it is on");

	for (const arm of ARMS) {
		await runArm(arm, dstId);
	}
} finally {
	if (prevDebug === null) {
		console.log("  cleanup: debug_mode left alone (the pre-read failed, so nothing was written)");
	} else {
		rcon(DST_INSTANCE,
			`remote.call('surface_export', 'configure', { debug_mode = ${prevDebug} })`);
		console.log(`  cleanup: destination debug_mode restored to ${prevDebug}`);
	}
}

if (failed) {
	console.log(`\n=== platform-paused-restore: ${failed} FAILURE(S) ===`);
	process.exit(1);
}
console.log("\n=== platform-paused-restore: ALL PASS ===");
