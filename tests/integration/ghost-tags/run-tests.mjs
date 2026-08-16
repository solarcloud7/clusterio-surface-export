#!/usr/bin/env node
// ghost-tags — an entity-ghost's tags must survive a real host-1 -> host-2 transfer, and the entity
// classes that measurably cannot hold tags are named by the same run
//
// requires: the cluster up, host-1 able to export, host-2 able to receive, debug_mode togglable on
//           host-2 via the configure remote (this runner ARMS it and restores the prior value,
//           because the gate verdict is read from a debug_import_result file never written with it off)
// produces: a measured ARM table naming, per entity class (entity-ghost, tile-ghost, steel-chest) and
//           per route (post-creation write vs the create_entity tags param), whether a tags write is
//           accepted and reads back at this pin; SOURCE physical reads of the armed ghosts through the
//           same reader used on the destination; the export payload's per-ghost tags record; the
//           destination gate verdict; and DESTINATION physical reads of tags on every ghost that
//           arrived. The ARM table is also ASSERTED as the coverage boundary over the classes it
//           measures: the fixture carries entity-ghosts only, so a pin at which the tile-ghost or the
//           steel-chest starts holding tags fails this suite rather than silently covering less than
//           it measured
// does not: measure any class outside the ARM table — the capture is ungated over every entity, and
//           display-panel, item-request-proxy and every other type are neither armed nor adjudicated
//           here, so this suite bounds three classes and not the capture's full reach; adjudicate tags
//           through the exact gate — the gate measures items and fluids only, so a
//           SUCCESS verdict is not evidence about tags and only the destination physical read decides;
//           exercise the production trigger (a blueprint carrying mod-authored tags), because the
//           fixture arms tags by script; cover tag values the JSON transport cannot express (an empty
//           table is ambiguous between object and array across it, and is deliberately absent from the
//           fixture); prove item or fluid fidelity; or touch the protected fixtures (it builds and
//           sweeps its own throwaway platform)

import {
	lua, rcon, instanceIds, createBatchLifecycle,
} from "../../lab-gallery/batch-lifecycle.mjs";
import { exportInspect } from "../../../tools/tests/testkit/export-inspect.mjs";

const RUN_TAG = Date.now().toString(36);
const PROBE = `ghosttags-${RUN_TAG}`;

const GHOST_INNER = "assembling-machine-3";
const TILE_INNER = "space-platform-foundation";

const GHOST_A = { x: 6.5, y: 6.5 };
const GHOST_B = { x: 11.5, y: 6.5 };
const ARM_ROW_Y = 18.5;
const OFF_PLATFORM_ARM_ROW_Y = 24.5;

const TAGS_A = "{note='hello', n=3, flag=true}";
const CANON_A = "{flag=true,n=3,note=hello}";
const TAGS_B = "{inner={a=1,b='two'}, list={10,20,30}}";
const CANON_B = "{inner={a=1,b=two},list={1=10,2=20,3=30}}";

const PLAN_A = "{{id={name='speed-module',quality='normal'},"
	+ "items={in_inventory={{inventory=defines.inventory.crafter_modules,stack=0,count=1}}}},"
	+ "{id={name='efficiency-module',quality='uncommon'},"
	+ "items={in_inventory={{inventory=defines.inventory.crafter_modules,stack=1,count=1}}}}}";

const CANON_LUA = "local function canon(v) if type(v)~='table' then "
	+ "if type(v)=='number' and v%1==0 then return string.format('%d',v) end return tostring(v) end "
	+ "local ks={} for k in pairs(v) do ks[#ks+1]=k end "
	+ "table.sort(ks, function(a,b) return tostring(a)<tostring(b) end) "
	+ "local ps={} for _,k in ipairs(ks) do ps[#ps+1]=tostring(k)..'='..canon(v[k]) end "
	+ "return '{'..table.concat(ps,',')..'}' end ";

const ARMS = [
	{ id: "entity_ghost_unarmed", entity: "entity-ghost", inner: GHOST_INNER },
	{ id: "entity_ghost_post_write", entity: "entity-ghost", inner: GHOST_INNER, postWrite: true },
	{ id: "entity_ghost_create_param", entity: "entity-ghost", inner: GHOST_INNER, createParam: true },
	{ id: "chest_unarmed", entity: "steel-chest" },
	{ id: "chest_post_write", entity: "steel-chest", postWrite: true },
	{ id: "tile_ghost_unarmed", entity: "tile-ghost", inner: TILE_INNER, offPlatform: true },
	{ id: "tile_ghost_post_write", entity: "tile-ghost", inner: TILE_INNER, offPlatform: true, postWrite: true },
	{ id: "tile_ghost_create_param", entity: "tile-ghost", inner: TILE_INNER, offPlatform: true, createParam: true },
];

let onPlatformSlot = 0;
let offPlatformSlot = 0;
for (const arm of ARMS) {
	arm.at = arm.offPlatform
		? { x: 6.5 + (offPlatformSlot++) * 4, y: OFF_PLATFORM_ARM_ROW_Y }
		: { x: 6.5 + (onPlatformSlot++) * 4, y: ARM_ROW_Y };
}

const GHOST_ROUTES = ["entity_ghost_post_write", "entity_ghost_create_param"];
const TILE_GHOST_ROUTES = ["tile_ghost_post_write", "tile_ghost_create_param"];

const L = createBatchLifecycle({
	goldenSourceSave: "unused.zip", goldenDestSave: "unused.zip",
	markerPrefix: "ghosttags",
});

const asArray = (v) => (Array.isArray(v) ? v : Object.values(v || {}));

let failed = 0;
const check = (ok, label, detail = "") => {
	console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
	if (!ok) failed++;
};

function canonJs(value) {
	if (value === null || typeof value !== "object") return String(value);
	const entries = Array.isArray(value)
		? value.map((item, index) => [String(index + 1), item])
		: Object.entries(value);
	entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	return `{${entries.map(([key, item]) => `${key}=${canonJs(item)}`).join(",")}}`;
}

function platformPrelude(platformName) {
	return `local plat for _,q in pairs(game.forces.player.platforms) do `
		+ `if q.valid and q.name=='${platformName}' then plat=q end end `
		+ `if not plat then return {success=false, error='platform ${platformName} not found'} end `
		+ "local s=plat.surface ";
}

function createLua(spec, varName, at, tagsExpr) {
	const inner = spec.inner ? `inner_name='${spec.inner}', ` : "";
	const tagParam = tagsExpr ? `, tags=${tagsExpr}` : "";
	return `local ${varName}=s.create_entity{name='${spec.entity}', ${inner}`
		+ `position={${at.x},${at.y}}, force='player'${tagParam}} `;
}

function armBlock(arm, index) {
	const i = index;
	return `local c${i},e${i}=pcall(function() `
		+ createLua(arm, "z", arm.at, arm.createParam ? TAGS_A : null)
		+ "return z end) "
		+ `local w${i},werr${i},r${i},t${i} `
		+ `if c${i} and e${i} and e${i}.valid then `
		+ (arm.postWrite ? `w${i},werr${i}=pcall(function() e${i}.tags=${TAGS_A} end) ` : "")
		+ `r${i},t${i}=pcall(function() return e${i}.tags end) `
		+ `e${i}.destroy() end `
		+ `out[#out+1]={arm='${arm.id}', created=((c${i} and e${i}~=nil) and true or false), `
		+ `create_err=(not c${i}) and tostring(e${i}) or nil, write_ok=w${i}, `
		+ `write_err=(w${i}==false) and tostring(werr${i}) or nil, read_ok=r${i}, `
		+ `read_err=(r${i}==false) and tostring(t${i}) or nil, `
		+ `tags=(r${i} and t${i}~=nil) and canon(t${i}) or nil} `;
}

function armProbeLua(platformName) {
	let body = platformPrelude(platformName) + CANON_LUA + "local out={} ";
	ARMS.forEach((arm, index) => { body += armBlock(arm, index); });
	return body + "return {success=true, arms=out} ";
}

function dumpTagsLua(platformName) {
	return platformPrelude(platformName) + CANON_LUA
		+ "local out={} "
		+ "for _,e in pairs(s.find_entities_filtered({type={'entity-ghost','tile-ghost'}})) do "
		+ "local ok,tg=pcall(function() return e.tags end) "
		+ "out[#out+1]={etype=e.type, inner=e.ghost_name, x=e.position.x, y=e.position.y, "
		+ "read_ok=ok, tags=(ok and tg~=nil) and canon(tg) or nil, "
		+ "read_err=(not ok) and tostring(tg) or nil, "
		+ "plan_len=(e.type=='entity-ghost') and #e.insert_plan or nil} end "
		+ "table.sort(out, function(a,b) return (a.y*1000+a.x) < (b.y*1000+b.x) end) "
		+ "return {success=true, index=plat.index, entities=out} ";
}

const keyOf = (record) => `${record.etype}@${record.x},${record.y}`;

function findAt(dump, at, etype) {
	return asArray(dump.entities).find(e => e.etype === etype
		&& Math.abs(e.x - at.x) < 0.01 && Math.abs(e.y - at.y) < 0.01);
}

function describeArm(arm) {
	return `  ARM ${arm.arm}: created=${arm.created}`
		+ (arm.create_err ? ` create_err=${arm.create_err}` : "")
		+ (arm.write_ok === undefined ? "" : ` write_ok=${arm.write_ok}`)
		+ (arm.write_err ? ` write_err=${arm.write_err}` : "")
		+ ` read_ok=${arm.read_ok} tags=${arm.tags === undefined ? "nil" : arm.tags}`
		+ (arm.read_err ? ` read_err=${arm.read_err}` : "");
}

async function main() {
	console.log(`=== ghost-tags: ghost tags survive a transfer (${PROBE}) ===`);
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

		const probe = lua(1, armProbeLua(PROBE));
		if (!probe.success) throw new Error(`arm probe failed: ${JSON.stringify(probe)}`);
		const arms = asArray(probe.arms);
		for (const arm of arms) console.log(describeArm(arm));

		const armById = new Map(arms.map(arm => [arm.arm, arm]));
		const landed = (id) => {
			const arm = armById.get(id);
			return !!arm && arm.created === true && arm.tags === CANON_A;
		};

		const ghostRoutes = GHOST_ROUTES.filter(landed);
		const tileGhostRoutes = TILE_GHOST_ROUTES.filter(landed);
		const chestHoldsTags = landed("chest_post_write");
		console.log(`  CLASS entity-ghost: ${ghostRoutes.length ? `holds tags via ${ghostRoutes.join(", ")}` : "NO ROUTE lands tags"}`);
		console.log(`  CLASS tile-ghost: ${tileGhostRoutes.length ? `holds tags via ${tileGhostRoutes.join(", ")}` : "no route lands tags at this pin"}`);
		console.log(`  CLASS steel-chest (non-ghost): ${chestHoldsTags ? "holds tags" : "cannot hold tags at this pin"}`);

		check(ghostRoutes.length > 0,
			"engine: at least one route puts tags on a fresh entity-ghost at this pin",
			JSON.stringify(arms.filter(arm => GHOST_ROUTES.includes(arm.arm))));
		if (ghostRoutes.length === 0) throw new Error("no route can arm a ghost with tags — fixture cannot be built");
		check(tileGhostRoutes.length === 0 && !chestHoldsTags,
			"class boundary: neither measured non-ghost class (tile-ghost, steel-chest) holds tags at this "
			+ "pin, so the entity-ghost fixture covers every class this suite has measured — either of them "
			+ "gaining tags needs a fixture arm and a destination check added here first",
			`tile-ghost routes=[${tileGhostRoutes.join(",")}] steel-chest=${chestHoldsTags}`);
		const chosen = ghostRoutes[0];
		console.log(`  ROUTE CHOSEN for the fixture: ${chosen}`);

		const armGhost = (varName, at, tagsExpr) => (chosen === "entity_ghost_create_param"
			? createLua({ entity: "entity-ghost", inner: GHOST_INNER }, varName, at, tagsExpr)
			: createLua({ entity: "entity-ghost", inner: GHOST_INNER }, varName, at, null)
				+ `${varName}.tags=${tagsExpr} `);

		const setup = lua(1, platformPrelude(PROBE)
			+ armGhost("ga", GHOST_A, TAGS_A)
			+ `ga.insert_plan=${PLAN_A} `
			+ armGhost("gb", GHOST_B, TAGS_B)
			+ "return {success=true, index=plat.index, plan_a=#ga.insert_plan} ");
		if (!setup.success) throw new Error(`fixture setup failed: ${JSON.stringify(setup)}`);

		const source = lua(1, dumpTagsLua(PROBE));
		if (!source.success) throw new Error(`source read failed: ${JSON.stringify(source)}`);
		const srcGhostA = findAt(source, GHOST_A, "entity-ghost");
		const srcGhostB = findAt(source, GHOST_B, "entity-ghost");
		check(!!srcGhostA && srcGhostA.tags === CANON_A,
			"source: ghost A is armed with flat scalar tags (string, integer, boolean)",
			srcGhostA ? String(srcGhostA.tags) : "ghost A missing");
		check(!!srcGhostB && srcGhostB.tags === CANON_B,
			"source: ghost B is armed with nested tags (a sub-table and a list)",
			srcGhostB ? String(srcGhostB.tags) : "ghost B missing");
		check(!!srcGhostA && srcGhostA.plan_len === 2,
			"source: ghost A also carries an insert_plan — the control arm rides the same entity",
			srcGhostA ? `plan_len=${srcGhostA.plan_len}` : "ghost A missing");

		const inspector = await exportInspect({ platform: PROBE, host: 1 });
		const ghostRecords = (inspector.entities || [])
			.filter(e => e.name === "entity-ghost" && e.position && Math.abs(e.position.y - GHOST_A.y) < 0.01);
		check(ghostRecords.length === 2, "payload: both entity-ghost records ride along",
			`entity-ghost records at y=${GHOST_A.y}: ${ghostRecords.length}`);
		for (const [label, at, want] of [["A", GHOST_A, CANON_A], ["B", GHOST_B, CANON_B]]) {
			const record = ghostRecords.find(e => Math.abs(e.position.x - at.x) < 0.01);
			check(!!record && record.tags !== undefined && canonJs(record.tags) === want,
				`payload: ghost ${label}'s tags are captured into the export record`,
				`want=${want} payload=${record && record.tags !== undefined ? canonJs(record.tags) : "absent"}`);
		}

		const marker = L.dropMarker(2, "transfer");
		rcon(1, `/transfer-platform ${setup.index} ${ids[2]}`);
		const { result } = await L.waitForImportResult(2, marker);
		check(result.validation_success === true,
			"transfer: exact gate passed (items and fluids only — it says nothing about tags)",
			`validation_success=${result.validation_success}`
			+ (result.validation_result && result.validation_result.mismatchDetails
				? ` — ${result.validation_result.mismatchDetails}` : ""));

		const dest = lua(2, dumpTagsLua(PROBE));
		if (!dest.success) throw new Error(`destination read failed: ${JSON.stringify(dest)}`);
		const dstGhostA = findAt(dest, GHOST_A, "entity-ghost");
		const dstGhostB = findAt(dest, GHOST_B, "entity-ghost");

		check(!!dstGhostA, "dest: ghost A arrived", JSON.stringify(asArray(dest.entities).map(keyOf)));
		check(!!dstGhostB, "dest: ghost B arrived", JSON.stringify(asArray(dest.entities).map(keyOf)));
		check(!!dstGhostA && dstGhostA.plan_len === 2,
			"CONTROL: ghost A's insert_plan arrives intact — the ghost restore path runs and this reader is sound",
			`plan_len=${dstGhostA ? dstGhostA.plan_len : "ghost A missing"}`);
		check(!!dstGhostA && dstGhostA.tags === CANON_A,
			"dest: ghost A's tags survive the transfer",
			`want=${CANON_A} dst=${dstGhostA ? String(dstGhostA.tags) : "ghost A missing"}`);
		check(!!dstGhostB && dstGhostB.tags === CANON_B,
			"dest: ghost B's nested tag values survive the transfer",
			`want=${CANON_B} dst=${dstGhostB ? String(dstGhostB.tags) : "ghost B missing"}`);

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
				console.error("  hand-clean with: tools/tests/cleanup-test-surfaces.ps1 (prefix ghosttags- is in its sweep list)");
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
		console.log(`=== ghost-tags: ${failed} FAILURE(S) ===`);
		process.exit(1);
	}
	console.log("=== ghost-tags: ALL PASS ===");
}

main().catch(error => {
	console.error(`ghost-tags: fatal — ${error && error.stack ? error.stack : error}`);
	process.exit(1);
});
