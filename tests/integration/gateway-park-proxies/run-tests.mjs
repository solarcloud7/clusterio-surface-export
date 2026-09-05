#!/usr/bin/env node

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

console.log(`=== gateway-park-proxies: BOTH proxy shapes must SURVIVE the park (${PROBE}) ===`);
const dstId = resolveInstanceId(DST_INSTANCE);

try {
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

	const parked = rconJson(SRC_INSTANCE,
		`(function() for _,q in pairs(game.forces.player.platforms) do if q.name=='${PROBE}' then `
		+ `return {state=q.state, parked=(q.state==defines.space_platform_state.waiting_at_station), `
		+ `at_gateway=(q.space_location~=nil and q.space_location.name=='${GATEWAY}')} end end `
		+ `return {parked=false} end)()`,
	);
	check(parked.parked === true && parked.at_gateway === true,
		"source reads waiting_at_station AT the gateway (the real /gateway-transfer gate)",
		`state=${parked.state}`);

	const trigger = rawCommand(SRC_INSTANCE, `/gateway-transfer ${setup.index} ${dstId}`);
	console.log(`  trigger: ${trigger.split("\n")[0] || "(no output)"}`);
	check(/Transfer queued|Gateway transfer/.test(trigger) && !/not parked|✗/.test(trigger),
		"the trigger accepted the transfer", trigger);

	const destScanLua =
		`(function() for _,q in pairs(game.forces.player.platforms) do if q.name=='${PROBE}' then `
		+ `return {present=true, entities=q.surface.count_entities_filtered{}, `
		+ `proxies=q.surface.count_entities_filtered{name='item-request-proxy'}, `
		+ `hub_proxies=(function() local n=0 for _,pr in pairs(q.surface.find_entities_filtered{name='item-request-proxy'}) do `
		+ `if pr.proxy_target and pr.proxy_target.valid and pr.proxy_target.name=='space-platform-hub' then n=n+1 end end return n end)(), `
		+ `paused=q.paused, state=q.state, state_paused=(q.state==defines.space_platform_state.paused), `
		+ `at_gateway=(q.space_location~=nil and q.space_location.name=='${GATEWAY}')} end end `
		+ `return {present=false} end)()`;
	let arrived = null;
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		await sleep(3000);
		const dst = rconJson(DST_INSTANCE, destScanLua);
		if (!dst.present) continue;
		const src = rconJson(SRC_INSTANCE,
			`(function() for _,q in pairs(game.forces.player.platforms) do if q.name=='${PROBE}' then return {present=true} end end return {present=false} end)()`,
		);
		if (!src.present) {
			arrived = rconJson(DST_INSTANCE, destScanLua);
			break;
		}
	}
	check(arrived !== null && arrived.present === true,
		"TERMINAL: destination present AND source deleted (the 2PC completed) within 120s");

	if (arrived) {
		const verdict = readDestImportResult();
		check(verdict !== null && verdict.platform_name === PROBE && verdict.validation_success === true,
			"the destination's debug_import_result reports validation_success for THIS platform",
			verdict ? `platform=${verdict.platform_name} success=${verdict.validation_success}` : "no debug_import_result found");

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
				+ `if q.surface and q.surface.valid then game.delete_surface(q.surface) n=n+1 end end end `
				+ `remote.call('surface_export','configure',{active_gateways_json=helpers.table_to_json(`
				+ `(storage.surface_export_config and storage.surface_export_config.active_gateways) or {})}) `
				+ `return {swept=n} end)()`,
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
