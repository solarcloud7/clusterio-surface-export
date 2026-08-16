#!/usr/bin/env node
// platform-paused-restore — a transferred platform must arrive in the paused state its SOURCE carried
//
// requires: the cluster up, host-1 able to export, host-2 able to receive, debug_mode on (each arm
//           reads the destination gate verdict from debug_import_result BEFORE any destination
//           platform-state read)
// produces: per-arm fresh default + SOURCE arming readback, the destination gate verdict, and TWO
//           destination physical reads of platform.paused and platform.state — one at arrival, one
//           after a settling delay — for a PAUSED source arm and an UNPAUSED source arm (control)
// does not: park at a gateway (a park owns the terminal pause by its own contract — that arm is
//           gateway-park-proxies, which asserts an UNPAUSED source arrives PAUSED when parked);
//           assert item/fluid fidelity (the gate does that); touch the protected fixtures (each arm
//           builds and sweeps its own throwaway platform); exercise latch re-arm — a starter-pack
//           platform carries no decider-combinator, so the settling read covers the post-completion
//           path (source delete, unlock, subscription emit), not LatchRearm

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
		`ls -t ${DST_SCRIPT_OUTPUT}/debug_import_result_*.json 2>/dev/null | head -1`], { encoding: "utf8" }).trim();
	if (!file) return null;
	const body = execFileSync("docker", ["exec", DST_CONTAINER, "sh", "-c", `cat '${file}'`], { encoding: "utf8" });
	return JSON.parse(body);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failed = 0;
const check = (ok, label, detail = "") => {
	console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
	if (!ok) failed++;
};

const platformStateLua = name =>
	`(function() for _,q in pairs(game.forces.player.platforms) do if q.name=='${name}' then `
	+ `return {present=true, paused=(q.paused==true), state=q.state, `
	+ `state_paused=(q.state==defines.space_platform_state.paused)} end end `
	+ `return {present=false} end)()`;

function sweep(name) {
	for (const instance of [SRC_INSTANCE, DST_INSTANCE]) {
		try {
			const swept = rconJson(instance,
				`(function() local n=0 for _,q in pairs(game.forces.player.platforms) do if q.name=='${name}' then `
				+ `pcall(remote.call, 'surface_export', 'unlock_platform', q.index) `
				+ `if q.surface and q.surface.valid then game.delete_surface(q.surface) n=n+1 end end end return {swept=n} end)()`,
			);
			if (swept.swept > 0) console.log(`  cleanup(${instance}): swept ${swept.swept} probe platform(s)`);
		} catch (sweepErr) {
			failed++;
			console.error(`  FAIL cleanup sweep on ${instance} threw: ${sweepErr && sweepErr.message ? sweepErr.message : sweepErr}`);
		}
	}
}

async function runArm(arm, dstId) {
	const probe = `pausedrs-${arm.id}-${RUN_TAG}`;
	console.log(`\n--- arm '${arm.id}': ${arm.label} must arrive paused=${arm.armed} (${probe}) ---`);
	try {
		const setup = rconJson(SRC_INSTANCE,
			`(function() local force=game.forces.player `
			+ `local p=force.create_space_platform{name='${probe}', planet='nauvis', starter_pack='space-platform-starter-pack'} `
			+ `p.apply_starter_pack() `
			+ `local fresh=(p.paused==true) `
			+ `p.paused=${arm.armed} `
			+ `return {index=p.index, fresh_paused=fresh, armed_paused=(p.paused==true), `
			+ `armed_state_paused=(p.state==defines.space_platform_state.paused)} end)()`,
		);
		console.log(`  source: index=${setup.index} fresh default paused=${setup.fresh_paused} `
			+ `-> armed paused=${setup.armed_paused} (state_paused=${setup.armed_state_paused})`);
		check(setup.armed_paused === arm.armed,
			`ARMED: the source platform reads back paused=${arm.armed} before any export`,
			`source reads paused=${setup.armed_paused}`);
		if (setup.armed_paused !== arm.armed) return;

		const trigger = rawCommand(SRC_INSTANCE, `/transfer-platform ${setup.index} ${dstId}`);
		check(/Export queued/.test(trigger) && !/Transfer failed/.test(trigger),
			"the trigger accepted the transfer", trigger.split("\n").filter(Boolean).slice(-2).join(" / "));

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
			`TERMINAL: destination present AND source deleted (the 2PC completed) within ${ARRIVAL_WAIT_MS / 1000}s`);
		if (!arrived) return;

		const verdict = readDestImportResult();
		check(verdict !== null && verdict.platform_name === probe && verdict.validation_success === true,
			"the destination's debug_import_result reports validation_success for THIS platform",
			verdict ? `platform=${verdict.platform_name} success=${verdict.validation_success}` : "no debug_import_result found");

		const atArrival = rconJson(DST_INSTANCE, platformStateLua(probe));
		await sleep(SETTLE_MS);
		const settled = rconJson(DST_INSTANCE, platformStateLua(probe));
		console.log(`  destination: at arrival paused=${atArrival.paused} state=${atArrival.state}; `
			+ `after ${SETTLE_MS / 1000}s paused=${settled.paused} state=${settled.state}`);

		check(atArrival.paused === arm.armed && atArrival.state_paused === arm.armed,
			`the destination platform arrives paused=${arm.armed} — the state its source carried`,
			`arrival read paused=${atArrival.paused} state=${atArrival.state}`);
		check(settled.present === true && settled.paused === arm.armed && settled.state_paused === arm.armed,
			`the arrived pause state SURVIVES ${SETTLE_MS / 1000}s of post-completion work`,
			`settled read present=${settled.present} paused=${settled.paused} state=${settled.state}`);
	} finally {
		sweep(probe);
	}
}

console.log(`=== platform-paused-restore: platform.paused must survive a transfer, both directions (${RUN_TAG}) ===`);
const dstId = resolveInstanceId(DST_INSTANCE);

for (const arm of ARMS) {
	await runArm(arm, dstId);
}

if (failed) {
	console.log(`\n=== platform-paused-restore: ${failed} FAILURE(S) ===`);
	process.exit(1);
}
console.log("\n=== platform-paused-restore: ALL PASS ===");
