#!/usr/bin/env node

import {
	lua, rcon, instanceIds, createBatchLifecycle,
} from "../../lab-gallery/batch-lifecycle.mjs";
import { exportInspect } from "../../../tools/tests/testkit/export-inspect.mjs";

const RUN_TAG = Date.now().toString(36);
const PROBE = `ghostreq-${RUN_TAG}`;

const GHOST_INNER = "assembling-machine-3";
const GHOST_A = { x: 6.5, y: 6.5 };
const GHOST_B = { x: 11.5, y: 6.5 };
const CHEST = { x: 16.5, y: 6.5 };
const PROBE_ROW_Y = 18.5;

const PLAN_A = "{{id={name='speed-module',quality='normal'},"
	+ "items={in_inventory={{inventory=defines.inventory.crafter_modules,stack=0,count=1}}}},"
	+ "{id={name='efficiency-module',quality='uncommon'},"
	+ "items={in_inventory={{inventory=defines.inventory.crafter_modules,stack=1,count=1}}}}}";
const PLAN_B = "{{id={name='productivity-module',quality='rare'},"
	+ "items={in_inventory={{inventory=defines.inventory.crafter_modules,stack=0,count=2}}}}}";
const PLAN_PROXY = "{{id={name='iron-plate',quality='normal'},"
	+ "items={in_inventory={{inventory=defines.inventory.chest,stack=0,count=10}}}}}";

const EXPECT_A = "efficiency-module/uncommonx1,speed-module/normalx1";
const EXPECT_B = "productivity-module/rarex2";
const EXPECT_PROXY = "iron-plate/normalx10";

const ROUTES = [
	{ id: "post_creation_insert_plan_write", param: null },
	{ id: "create_insert_plan", param: "insert_plan" },
	{ id: "create_item_requests", param: "item_requests" },
	{ id: "create_modules", param: "modules" },
];

const L = createBatchLifecycle({
	goldenSourceSave: "unused.zip", goldenDestSave: "unused.zip",
	markerPrefix: "ghostreq",
});

const asArray = (v) => (Array.isArray(v) ? v : Object.values(v || {}));

let failed = 0;
const check = (ok, label, detail = "") => {
	console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
	if (!ok) failed++;
};

function platformPrelude(platformName) {
	return `local plat for _,q in pairs(game.forces.player.platforms) do `
		+ `if q.valid and q.name=='${platformName}' then plat=q end end `
		+ `if not plat then return {success=false, error='platform ${platformName} not found'} end `
		+ "local s=plat.surface ";
}

function ghostCreateLua(route, varName, at, planExpr) {
	const fields = `name='entity-ghost', inner_name='${GHOST_INNER}', `
		+ `position={${at.x},${at.y}}, force='player'`;
	if (route === "post_creation_insert_plan_write") {
		return `local ${varName}=s.create_entity{${fields}} ${varName}.insert_plan=${planExpr} `;
	}
	const param = ROUTES.find(r => r.id === route).param;
	return `local ${varName}=s.create_entity{${fields}, ${param}=${planExpr}} `;
}

function routeProbeLua(platformName) {
	let body = platformPrelude(platformName) + "local out={} ";
	ROUTES.forEach((route, index) => {
		const at = { x: 6.5 + index * 4, y: PROBE_ROW_Y };
		body += `local ok${index},res${index}=pcall(function() `
			+ ghostCreateLua(route.id, "g", at, PLAN_A)
			+ "return g end) "
			+ `local n${index}=-1 local e${index} `
			+ `if ok${index} then if res${index} and res${index}.valid then `
			+ `n${index}=#res${index}.item_requests res${index}.destroy() end `
			+ `else e${index}=tostring(res${index}) end `
			+ `out[#out+1]={route='${route.id}', ok=ok${index}, err=e${index}, requests=n${index}} `;
	});
	return body + "return {success=true, routes=out} ";
}

function dumpRequestsLua(platformName) {
	return platformPrelude(platformName)
		+ "local out={} "
		+ "for _,e in pairs(s.find_entities_filtered({type={'entity-ghost','item-request-proxy'}})) do "
		+ "local reqs={} "
		+ "for _,r in pairs(e.item_requests or {}) do "
		+ "reqs[#reqs+1]={name=r.name, quality=r.quality, count=r.count} end "
		+ "table.sort(reqs, function(a,b) return (a.name..a.quality) < (b.name..b.quality) end) "
		+ "out[#out+1]={etype=e.type, inner=(e.type=='entity-ghost' and e.ghost_name or nil), "
		+ "x=e.position.x, y=e.position.y, plan_len=#e.insert_plan, requests=reqs} end "
		+ "table.sort(out, function(a,b) return (a.y*1000+a.x) < (b.y*1000+b.x) end) "
		+ "return {success=true, index=plat.index, entities=out} ";
}

const keyOf = (record) => `${record.etype}@${record.x},${record.y}`;
const requestsOf = (record) => asArray(record && record.requests)
	.map(r => `${r.name}/${r.quality}x${r.count}`).join(",");

function findAt(dump, at, etype) {
	return asArray(dump.entities).find(e => e.etype === etype
		&& Math.abs(e.x - at.x) < 0.01 && Math.abs(e.y - at.y) < 0.01);
}

async function main() {
	console.log(`=== ghost-item-requests: ghost item requests survive a transfer (${PROBE}) ===`);
	const ids = instanceIds();

	const prevDebug = lua(2, "return {success=true, debug=(storage.surface_export_config "
		+ "and storage.surface_export_config.debug_mode) == true}");
	lua(2, "remote.call('surface_export','configure',{debug_mode=true}) return {success=true}");

	try {
		const created = lua(1,
			`local p=game.forces.player.create_space_platform{name='${PROBE}', planet='nauvis', `
			+ "starter_pack='space-platform-starter-pack'} "
			+ "p.apply_starter_pack() "
			+ "local tiles={} for x=2,22 do for y=2,22 do "
			+ "tiles[#tiles+1]={name='space-platform-foundation', position={x,y}} end end "
			+ "p.surface.set_tiles(tiles) "
			+ "return {success=true, index=p.index}");
		if (!created.success) throw new Error(`platform setup failed: ${JSON.stringify(created)}`);

		const probe = lua(1, routeProbeLua(PROBE));
		if (!probe.success) throw new Error(`route probe failed: ${JSON.stringify(probe)}`);
		const routes = asArray(probe.routes);
		for (const route of routes) {
			console.log(`  ROUTE ${route.route}: ok=${route.ok} requests=${route.requests}`
				+ (route.err ? ` err=${route.err}` : ""));
		}
		const working = routes.filter(r => r.ok === true && r.requests > 0);
		check(working.length > 0,
			"engine: at least one route puts item requests on a fresh entity-ghost at this pin",
			JSON.stringify(routes));
		if (working.length === 0) throw new Error("no route can arm a ghost — fixture cannot be built");
		const chosen = working[0].route;
		console.log(`  ROUTE CHOSEN for the fixture and for the production restore: ${chosen}`);

		const setup = lua(1, platformPrelude(PROBE)
			+ ghostCreateLua(chosen, "ga", GHOST_A, PLAN_A)
			+ ghostCreateLua(chosen, "gb", GHOST_B, PLAN_B)
			+ `local chest=s.create_entity{name='steel-chest', position={${CHEST.x},${CHEST.y}}, force='player'} `
			+ `local proxy=s.create_entity{name='item-request-proxy', position={${CHEST.x},${CHEST.y}}, `
			+ `force='player', target=chest, modules=${PLAN_PROXY}} `
			+ "return {success=true, index=plat.index, ghost_a=#ga.item_requests, "
			+ "ghost_b=#gb.item_requests, proxy=(proxy and proxy.valid) and #proxy.item_requests or -1} ");
		if (!setup.success) throw new Error(`fixture setup failed: ${JSON.stringify(setup)}`);
		check(setup.ghost_a === 2 && setup.ghost_b === 1 && setup.proxy === 1,
			"fixture: both ghosts and the control proxy are armed with pending requests",
			JSON.stringify(setup));

		const source = lua(1, dumpRequestsLua(PROBE));
		if (!source.success) throw new Error(`source read failed: ${JSON.stringify(source)}`);
		const srcGhostA = findAt(source, GHOST_A, "entity-ghost");
		const srcGhostB = findAt(source, GHOST_B, "entity-ghost");
		const srcProxy = findAt(source, CHEST, "item-request-proxy");
		check(!!srcGhostA && requestsOf(srcGhostA) === EXPECT_A,
			"source: ghost A requests two modules, one at uncommon quality",
			srcGhostA ? requestsOf(srcGhostA) : "ghost A missing");
		check(!!srcGhostB && requestsOf(srcGhostB) === EXPECT_B,
			"source: ghost B requests two rare-quality productivity modules",
			srcGhostB ? requestsOf(srcGhostB) : "ghost B missing");
		check(!!srcProxy && requestsOf(srcProxy) === EXPECT_PROXY,
			"source: control proxy requests ten iron plates",
			srcProxy ? requestsOf(srcProxy) : "proxy missing");

		const inspector = await exportInspect({ platform: PROBE, host: 1 });
		const ghostRecords = (inspector.entities || [])
			.filter(e => e.name === "entity-ghost" && e.position && Math.abs(e.position.y - GHOST_A.y) < 0.01);
		check(ghostRecords.length === 2, "payload: both entity-ghost records ride along",
			`entity-ghost records at y=${GHOST_A.y}: ${ghostRecords.length}`);
		const withPlan = ghostRecords.filter(e => e.specific_data
			&& asArray(e.specific_data.insert_plan).length > 0);
		check(withPlan.length === 2,
			"payload: every ghost record carries insert_plan — the WRITABLE form "
			+ "(item_requests is read-only at this pin, so a payload without insert_plan cannot restore)",
			JSON.stringify(ghostRecords.map(e => ({
				insert_plan: e.specific_data && e.specific_data.insert_plan,
				item_requests: e.specific_data && e.specific_data.item_requests,
			}))));

		const marker = L.dropMarker(2, "transfer");
		rcon(1, `/transfer-platform ${setup.index} ${ids[2]}`);
		const { result } = await L.waitForImportResult(2, marker);
		check(result.validation_success === true, "transfer: exact gate passed",
			`validation_success=${result.validation_success}`
			+ (result.validation_result && result.validation_result.mismatchDetails
				? ` — ${result.validation_result.mismatchDetails}` : ""));

		const dest = lua(2, dumpRequestsLua(PROBE));
		if (!dest.success) throw new Error(`destination read failed: ${JSON.stringify(dest)}`);
		const dstGhostA = findAt(dest, GHOST_A, "entity-ghost");
		const dstGhostB = findAt(dest, GHOST_B, "entity-ghost");
		const dstProxy = findAt(dest, CHEST, "item-request-proxy");

		check(!!dstProxy && requestsOf(dstProxy) === EXPECT_PROXY,
			"CONTROL: the item-request-proxy's requests arrive intact (probe is sound)",
			`want=${EXPECT_PROXY} dst=${dstProxy ? requestsOf(dstProxy) : "proxy missing"}`);

		check(!!dstGhostA, "dest: ghost A arrived", JSON.stringify(asArray(dest.entities).map(keyOf)));
		check(!!dstGhostB, "dest: ghost B arrived", JSON.stringify(asArray(dest.entities).map(keyOf)));
		check(!!dstGhostA && requestsOf(dstGhostA) === EXPECT_A,
			"dest: ghost A's item requests survive the transfer, quality included",
			`want=${EXPECT_A} dst=${dstGhostA ? requestsOf(dstGhostA) : "ghost A missing"}`);
		check(!!dstGhostB && requestsOf(dstGhostB) === EXPECT_B,
			"dest: ghost B's item requests survive the transfer, quality included",
			`want=${EXPECT_B} dst=${dstGhostB ? requestsOf(dstGhostB) : "ghost B missing"}`);

		const sourceGone = lua(1, "for _,q in pairs(game.forces.player.platforms) do "
			+ `if q.valid and q.name=='${PROBE}' then return {success=true,present=true} end end `
			+ "return {success=true,present=false}");
		check(sourceGone.present === false, "transfer: source deleted (two-phase commit)");
	} finally {
		for (const host of [1, 2]) {
			try {
				const swept = lua(host, "local n=0 for _,q in pairs(game.forces.player.platforms) do "
					+ `if q.valid and q.name=='${PROBE}' then `
					+ "pcall(remote.call,'surface_export','unlock_platform',q.index) "
					+ "if q.surface and q.surface.valid then game.delete_surface(q.surface) n=n+1 end end end "
					+ "return {success=true, swept=n}");
				console.log(`  cleanup host ${host}: swept ${swept.swept} probe platform(s)`);
			} catch (sweepErr) {
				failed++;
				console.error(`  FAIL cleanup host ${host} threw: ${sweepErr && sweepErr.message ? sweepErr.message : sweepErr}`);
				console.error("  hand-clean with: tools/tests/cleanup-test-surfaces.ps1 (prefix ghostreq- is in its sweep list)");
			}
		}
		try {
			lua(2, `remote.call('surface_export','configure',{debug_mode=${prevDebug.debug === true}}) `
				+ "return {success=true}");
		} catch (cfgErr) {
			failed++;
			console.error(`  FAIL debug_mode restore threw: ${cfgErr && cfgErr.message ? cfgErr.message : cfgErr}`);
		}
	}

	if (failed) {
		console.log(`=== ghost-item-requests: ${failed} FAILURE(S) ===`);
		process.exit(1);
	}
	console.log("=== ghost-item-requests: ALL PASS ===");
}

main().catch(error => {
	console.error(`ghost-item-requests: fatal — ${error && error.stack ? error.stack : error}`);
	process.exit(1);
});
