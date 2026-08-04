#!/usr/bin/env node
// Gateway-park proxy survival — the adversarial fixture for the proxy-cancellation defect
// (measured 2026-08-03): writing `space_location` destroys item-request proxies on the platform
// surface (upstream-documented "will cancel pending item requests"; measured 1 → 0 on 2.1.11).
// The gateway park used to perform that write as the LAST import step — after restoration
// re-created proxies (the 9326ca8 loss class) and after the exact gate had passed — so every
// gateway-parked import of a proxy-carrying platform silently lost its proxies, post-verdict,
// invisible to the gate by construction. The fix parks at CREATION (empty surface, nothing to
// cancel); this fixture is the physical teeth: a real gateway transfer of a proxy-carrying
// platform, PHYSICAL proxy count on the destination. RED on pre-fix code (count 0), GREEN on the
// fix (count 1 + parked paused at the gateway).
//
// Probe choreography note: the SOURCE park write (which makes /gateway-transfer's parked_at_gateway
// gate pass) itself cancels proxies — so the source proxy is created AFTER the park write.
//
// Zero leftovers: the source platform is deleted by the transfer's own 2PC; the arrived destination
// copy is swept in the finally (unique per-run name; `gwpark-probe` prefix is in
// cleanup-test-surfaces.ps1's sweep list as the backstop).

import { execFileSync } from "node:child_process";

const CONTROLLER = "surface-export-controller";
const CTL_CONFIG = "/clusterio/tokens/config-control.json";
const SRC_INSTANCE = "clusterio-host-1-instance-1";
const DST_INSTANCE = "clusterio-host-2-instance-1";
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
	return JSON.parse(line);
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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failed = 0;
const check = (ok, label, detail = "") => {
	console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
	if (!ok) failed++;
};

console.log(`=== gateway-park-proxies: restored proxies must SURVIVE the park (${PROBE}) ===`);
const dstId = resolveInstanceId(DST_INSTANCE);

try {
	// SOURCE: create a platform, PARK it at the gateway FIRST (this write cancels proxies, which is
	// the whole point — so the proxy is created after), THEN add an assembler + an item-request
	// proxy TARGETING IT. The target must be a REGULAR entity: a hub-targeted proxy never rides the
	// export at all (measured while building this fixture — a separate serializer gap, filed
	// independently), which would make this fixture red for the wrong reason.
	const setup = rconJson(SRC_INSTANCE,
		`(function() local force=game.forces.player `
		+ `local p=force.create_space_platform{name='${PROBE}', planet='nauvis', starter_pack='space-platform-starter-pack'} `
		+ `p.apply_starter_pack() `
		+ `pcall(function() force.unlock_space_location('${GATEWAY}') end) `
		+ `local sched=p.get_schedule() sched.add_record{station='${GATEWAY}', index={schedule_index=1}} `
		+ `p.space_location='${GATEWAY}' `
		+ `p.paused=false `
		+ `local am=p.surface.create_entity{name='assembling-machine-2', position={3,3}, force='player'} `
		+ `local proxy=p.surface.create_entity{name='item-request-proxy', position=am.position, force='player', target=am, `
		+ `modules={{id={name='speed-module'}, items={in_inventory={{inventory=defines.inventory.crafter_modules, stack=0, count=1}}}}}} `
		+ `return {index=p.index, state=p.state, proxy_ok=(proxy~=nil and proxy.valid), `
		+ `proxies=p.surface.count_entities_filtered{name='item-request-proxy'}, `
		+ `parked=(p.space_location~=nil and p.space_location.name=='${GATEWAY}')} end)()`,
	);
	check(setup.proxy_ok === true && setup.proxies === 1,
		"source platform carries one assembler-targeted item-request proxy (created AFTER the park; "
		+ "this shape is payload-verified — record types include item-request-proxy)");
	check(setup.parked === true, "source is parked at the gateway (the /gateway-transfer gate)", `state=${setup.state}`);

	// Drive the REAL gateway transfer (the production trigger: parked-gate + explicit destination).
	const trigger = rawCommand(SRC_INSTANCE, `/gateway-transfer ${setup.index} ${dstId}`);
	console.log(`  trigger: ${trigger.split("\n")[0] || "(no output)"}`);

	// Await arrival on the destination: platform present with MORE than the hub (restoration ran).
	let arrived = null;
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		await sleep(3000);
		const scan = rconJson(DST_INSTANCE,
			`(function() for _,q in pairs(game.forces.player.platforms) do if q.name=='${PROBE}' then `
			+ `return {present=true, entities=q.surface.count_entities_filtered{}, `
			+ `proxies=q.surface.count_entities_filtered{name='item-request-proxy'}, `
			+ `paused=q.paused, at_gateway=(q.space_location~=nil and q.space_location.name=='${GATEWAY}')} end end `
			+ `return {present=false} end)()`,
		);
		if (scan.present && scan.entities >= 1) { arrived = scan; break; }
	}
	check(arrived !== null, "the platform arrived on the destination within 120s");
	if (arrived) {
		// THE TEETH: the physical proxy count on the destination. Pre-fix, the end-of-import park
		// write destroyed the restored proxy AFTER the verdict — count 0. The gate cannot see it
		// (proxies are requests, not items), which is why this fixture counts PHYSICALLY.
		check(arrived.proxies === 1,
			"THE DEFECT: the restored item-request proxy survived the gateway park",
			`physical proxy count on destination: ${arrived.proxies}`);
		check(arrived.paused === true, "arrived PAUSED (parked, not flying the schedule)");
		check(arrived.at_gateway === true, "arrived AT the gateway location");
	}

	// The 2PC must have deleted the source (this is a real transfer, not a copy).
	const srcGone = rconJson(SRC_INSTANCE,
		`(function() for _,q in pairs(game.forces.player.platforms) do if q.name=='${PROBE}' then return {present=true} end end return {present=false} end)()`,
	);
	check(srcGone.present === false, "source platform deleted by the transfer's own 2PC");
} finally {
	// Sweep the arrived copy (and any source leftover from a failed transfer) on BOTH instances.
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
