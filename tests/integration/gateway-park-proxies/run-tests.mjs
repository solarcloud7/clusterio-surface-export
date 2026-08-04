#!/usr/bin/env node
// Gateway-park proxy survival — proxies riding a GATEWAY transfer, counted PHYSICALLY on the
// destination (the exact gate is structurally blind to proxies: they are requests, not items —
// the class that dropped them silently until 9326ca8). This is the standing pin for the whole
// chain: both proxy-target shapes export, restore, and survive arrival at a gateway park.
//
// TWO proxy shapes ride, deliberately — the family, enumerated at the emitter: an
// ASSEMBLER-targeted proxy (modules into a machine) and a HUB-targeted one (items owed to the
// platform hub). Both measured surviving under BOTH park orderings through the full production
// path — this fixture has NO ordering-specific teeth, and says so.
//
// Measurement history, paid for while building this (the full account is in
// GATEWAY_TRANSFER_PRD.md):
//   - insert-plan stacks are 1-BASED. A stack=0 plan creates a proxy that sits on the surface but
//     never rides the export — an artifact that masqueraded first as a serializer gap and then as
//     a park-cancellation law, inverting this PR's severity label twice. Use valid stacks.
//   - the "space_location write destroys hub-targeted proxies (1 → 0)" observation is RETRACTED:
//     measured once (2026-08-03) and never reproduced — six survivals since across valid/malformed
//     shapes, same/deferred execution, and both orderings end-to-end. Upstream's documented
//     "will cancel pending item requests" evidently refers to something other than proxy entities.
//   - the SOURCE choreography still writes space_location BEFORE creating the proxies: cheap
//     defense in depth against whatever the upstream cancellation does cancel, and a parked source
//     is what the /gateway-transfer gate requires anyway.
//
// Readiness/verdict grounding (review findings B1/B2/B4): arrival is detected by the TERMINAL
// 2PC signal pair — destination platform present AND source platform GONE (the source is deleted
// only after the destination's verdict) — never by surface-content heuristics, which are true
// mid-import. The verdict itself is then read from the destination's debug_import_result file
// (validation_success + platform name) before any census claim.
//
// Zero leftovers: source deleted by the transfer's own 2PC; the arrived copy finally-swept on
// both instances; unique per-run probe name; `gwpark-probe` prefix in cleanup-test-surfaces.ps1.

import { execFileSync } from "node:child_process";

const CONTROLLER = "surface-export-controller";
const CTL_CONFIG = "/clusterio/tokens/config-control.json";
const SRC_INSTANCE = "clusterio-host-1-instance-1";
const DST_INSTANCE = "clusterio-host-2-instance-1";
const DST_CONTAINER = "surface-export-host-2";
const DST_SCRIPT_OUTPUT = "/clusterio/data/instances/clusterio-host-2-instance-1/script-output";
const GATEWAY = "surfexp_gateway_1";
const PROBE = `gwpark-probe-${Date.now().toString(36)}`;

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
		// A Lua throw comes back as an engine error line, not JSON — surface the RAW output so the
		// failure names the actual Lua problem instead of "Unexpected token" (review finding N5).
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
/** Newest debug_import_result on the destination — the import's own terminal verdict record. */
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

console.log(`=== gateway-park-proxies: BOTH proxy shapes must SURVIVE the park (${PROBE}) ===`);
const dstId = resolveInstanceId(DST_INSTANCE);

try {
	// SOURCE: create, park (the write that would kill a hub proxy — done before any exist), then
	// create BOTH proxy shapes.
	const setup = rconJson(SRC_INSTANCE,
		`(function() local force=game.forces.player `
		+ `local p=force.create_space_platform{name='${PROBE}', planet='nauvis', starter_pack='space-platform-starter-pack'} `
		+ `p.apply_starter_pack() `
		+ `pcall(function() force.unlock_space_location('${GATEWAY}') end) `
		+ `local sched=p.get_schedule() sched.add_record{station='${GATEWAY}', index={schedule_index=1}} `
		+ `p.space_location='${GATEWAY}' `
		+ `p.paused=false `
		+ `local hub=p.hub `
		+ `local am=p.surface.create_entity{name='assembling-machine-2', position={3,3}, force='player'} `
		+ `local am_proxy=p.surface.create_entity{name='item-request-proxy', position=am.position, force='player', target=am, `
		+ `modules={{id={name='speed-module'}, items={in_inventory={{inventory=defines.inventory.crafter_modules, stack=1, count=1}}}}}} `
		+ `local hub_proxy=p.surface.create_entity{name='item-request-proxy', position=hub.position, force='player', target=hub, `
		+ `modules={{id={name='iron-plate'}, items={in_inventory={{inventory=defines.inventory.hub_main, stack=1, count=10}}}}}} `
		+ `return {index=p.index, am_ok=(am_proxy~=nil and am_proxy.valid), hub_ok=(hub_proxy~=nil and hub_proxy.valid), `
		+ `proxies=p.surface.count_entities_filtered{name='item-request-proxy'}} end)()`,
	);
	check(setup.am_ok === true && setup.hub_ok === true && setup.proxies === 2,
		"source carries BOTH proxy shapes (assembler- and hub-targeted, valid 1-based stacks)",
		`proxies=${setup.proxies}`);

	// Parked-state precheck in a LATER execution: the /gateway-transfer gate is
	// state == waiting_at_station, which settles after the same-execution location write.
	const parked = rconJson(SRC_INSTANCE,
		`(function() for _,q in pairs(game.forces.player.platforms) do if q.name=='${PROBE}' then `
		+ `return {state=q.state, parked=(q.state==defines.space_platform_state.waiting_at_station), `
		+ `at_gateway=(q.space_location~=nil and q.space_location.name=='${GATEWAY}')} end end `
		+ `return {parked=false} end)()`,
	);
	check(parked.parked === true && parked.at_gateway === true,
		"source reads waiting_at_station AT the gateway (the real /gateway-transfer gate)",
		`state=${parked.state}`);

	// Drive the REAL gateway transfer and assert the trigger ACCEPTED (review finding B4: the
	// command reports refusals by print and returns normally — the output is the contract).
	const trigger = rawCommand(SRC_INSTANCE, `/gateway-transfer ${setup.index} ${dstId}`);
	console.log(`  trigger: ${trigger.split("\n")[0] || "(no output)"}`);
	check(/Transfer queued|Gateway transfer/.test(trigger) && !/not parked|✗/.test(trigger),
		"the trigger accepted the transfer", trigger);

	// TERMINAL readiness (review finding B1): destination present AND source GONE. The 2PC deletes
	// the source only after the destination's verdict, so this pair cannot be observed mid-import.
	let arrived = null;
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		await sleep(3000);
		const dst = rconJson(DST_INSTANCE,
			`(function() for _,q in pairs(game.forces.player.platforms) do if q.name=='${PROBE}' then `
			+ `return {present=true, entities=q.surface.count_entities_filtered{}, `
			+ `proxies=q.surface.count_entities_filtered{name='item-request-proxy'}, `
			+ `hub_proxies=(function() local n=0 for _,pr in pairs(q.surface.find_entities_filtered{name='item-request-proxy'}) do `
			+ `if pr.proxy_target and pr.proxy_target.valid and pr.proxy_target.name=='space-platform-hub' then n=n+1 end end return n end)(), `
			+ `paused=q.paused, state=q.state, state_paused=(q.state==defines.space_platform_state.paused), `
			+ `at_gateway=(q.space_location~=nil and q.space_location.name=='${GATEWAY}')} end end `
			+ `return {present=false} end)()`,
		);
		if (!dst.present) continue;
		const src = rconJson(SRC_INSTANCE,
			`(function() for _,q in pairs(game.forces.player.platforms) do if q.name=='${PROBE}' then return {present=true} end end return {present=false} end)()`,
		);
		if (!src.present) { arrived = dst; break; }
	}
	check(arrived !== null, "TERMINAL: destination present AND source deleted (the 2PC completed) within 120s");

	if (arrived) {
		// Verdict grounding (review finding B2): the import's own terminal record, not just the census.
		const verdict = readDestImportResult();
		check(verdict !== null && verdict.platform_name === PROBE && verdict.validation_success === true,
			"the destination's debug_import_result reports validation_success for THIS platform",
			verdict ? `platform=${verdict.platform_name} success=${verdict.validation_success}` : "no debug_import_result found");

		// The physical census, per shape. A miss here is proxy loss SOMEWHERE in the chain
		// (export, restore, or arrival) — the gate cannot see it, which is why this pin exists.
		check(arrived.proxies === 2,
			"BOTH restored proxies survived the gateway transfer (physical count, per the gate-blind class)",
			`physical proxy count on destination: ${arrived.proxies} (hub-targeted: ${arrived.hub_proxies})`);
		check(arrived.hub_proxies === 1,
			"the hub-targeted proxy specifically survived (the shape two retracted measurements implicated)");
		check(arrived.paused === true && arrived.state_paused === true,
			"arrived PAUSED (parked, not flying the schedule)", `state=${arrived.state}`);
		check(arrived.at_gateway === true, "arrived AT the gateway location");
	}
} finally {
	for (const instance of [SRC_INSTANCE, DST_INSTANCE]) {
		try {
			const swept = rconJson(instance,
				`(function() local n=0 for _,q in pairs(game.forces.player.platforms) do if q.name=='${PROBE}' then `
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

if (failed) {
	console.log(`=== gateway-park-proxies: ${failed} FAILURE(S) ===`);
	process.exit(1);
}
console.log("=== gateway-park-proxies: ALL PASS ===");
