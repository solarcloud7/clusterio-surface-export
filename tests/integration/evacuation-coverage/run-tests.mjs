#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const CONTROLLER = process.env.SE_LAB_CONTROLLER || "surface-export-controller";
const CTL_CONFIG = "/clusterio/tokens/config-control.json";
const INSTANCE = process.env.SE_LAB_INSTANCE || "clusterio-host-1-instance-1";
const PROBE = `evac-coverage-probe-${Date.now().toString(36)}`;

function rcon(luaBody) {
	return execFileSync("docker", ["exec", CONTROLLER, "npx", "clusterioctl", "--config", CTL_CONFIG,
		"--log-level", "error", "instance", "send-rcon", INSTANCE, `/sc ${luaBody}`],
	{ encoding: "utf8", timeout: 30_000, maxBuffer: 1_048_576 }).trim();
}
function rconJson(luaExpr) {
	const out = rcon(`rcon.print(helpers.table_to_json(${luaExpr}))`);
	const line = out.split("\n").map(l => l.trim()).filter(Boolean).at(-1);
	return JSON.parse(line);
}

const asArray = (v) => (Array.isArray(v) ? v : Object.values(v || {}));

let failed = 0;
const check = (ok, label, detail = "") => {
	console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
	if (!ok) failed++;
};

console.log(`=== evacuation-coverage: a body aboard survives the source-delete chokepoint (${PROBE}) ===`);

let probeIndex = null;
let sourceIndex = null;
let bodyUnit = null;
try {
	const debug = rconJson(
		`(function() local cfg=storage.surface_export_config assert(cfg,'configuration missing') local saved=cfg.debug_mode `
		+ `cfg.debug_mode=false local denied={} for _,name in ipairs({'version_selftest','version_selftest_json','test_import_entity'}) do `
		+ `local ok,result=pcall(remote.call,'surface_export',name) denied[#denied+1]=not ok and tostring(result):find('debug_mode')~=nil end `
		+ `cfg.debug_mode=true local enabled,result=pcall(remote.call,'surface_export','version_selftest') cfg.debug_mode=saved `
		+ `return {denied=denied,enabled=enabled and result.failed==0,restored=cfg.debug_mode==saved,engine=script.active_mods.base} end)()`,
	);
	check(asArray(debug.denied).length === 3 && asArray(debug.denied).every(value => value === true),
		"registered debug commands refuse while debug is off");
	check(debug.enabled && debug.restored, "debug command works when enabled and original setting is restored");
	check(debug.engine === "2.1.17", "pinned Factorio 2.1.17 runtime", debug.engine);
	const setup = rconJson(
		`(function() local p=game.forces.player.create_space_platform{name='${PROBE}', planet='nauvis', starter_pack='space-platform-starter-pack'} `
		+ `p.apply_starter_pack() `
		+ `local body=p.surface.create_entity{name='character', position={2,3}, force='player'} `
		+ `return {index=p.index, body_unit=body and body.unit_number, body_ok=(body~=nil and body.valid), chars_aboard=p.surface.count_entities_filtered{type='character'}} end)()`,
	);
	probeIndex = setup.index ?? null;
	sourceIndex = probeIndex;
	bodyUnit = setup.body_unit ?? null;
	check(setup.body_ok === true && setup.chars_aboard === 1, "probe platform carries one character body");
	if (process.env.SE_EVAC_FAIL_AFTER_SETUP === "1") throw new Error("Injected harness failure after setup");

	const driven = rconJson(
		`(function() local locks=package.loaded['__level__/modules/surface_export/utils/surface-lock.lua'] `
		+ `assert(locks, 'SurfaceLock not loaded') local force=game.forces.player `
		+ `local ok, err=locks.lock_platform(force.platforms[${setup.index}], force, `
		+ `{kind='transfer', job_id='${PROBE}', expires_tick=game.tick+locks.DEFAULT_TRANSFER_LOCK_TTL_TICKS}) `
		+ `if not ok then return {locked=false, err=tostring(err)} end `
		+ `local identity=helpers.json_to_table(remote.call('surface_export','source_recovery_identity',${setup.index},'player','${PROBE}')) `
		+ `assert(identity.success and identity.platformUid, identity.error) `
		+ `local gateway=package.loaded['__level__/modules/surface_export/core/gateway.lua'] `
		+ `local original=gateway.evacuate_passengers local failures={} `
		+ `for _,mode in ipairs({'refused','throw','missing'}) do `
		+ `gateway.evacuate_passengers=function() if mode=='throw' then error('injected evacuation error') end `
		+ `if mode=='missing' then return nil end return {success=false,failures=1} end `
		+ `local called,result=pcall(remote.call,'surface_export','delete_platform_for_transfer',${setup.index},'${PROBE}','player','${PROBE}',identity.platformUid) `
		+ `gateway.evacuate_passengers=original `
		+ `local p=force.platforms[${setup.index}] local receipt=storage.surface_export_transfer_receipts and storage.surface_export_transfer_receipts.source_deleted `
		+ `failures[#failures+1]={mode=mode,refused=called and type(result)=='string' and result:sub(1,6)=='ERROR:', `
		+ `retained=p~=nil and p.valid and p.surface.count_entities_filtered{type='character'}==1, `
		+ `locked=storage.locked_platforms[${setup.index}]~=nil,receipt=receipt~=nil and receipt.records['${PROBE}']~=nil} end `
		+ `local result = remote.call('surface_export', 'delete_platform_for_transfer', ${setup.index}, '${PROBE}', 'player', '${PROBE}', identity.platformUid) `
		+ `local replay=remote.call('surface_export','delete_platform_for_transfer',${setup.index},'${PROBE}','player','${PROBE}',identity.platformUid) `
		+ `local after=force.platforms[${setup.index}] `
		+ `return {locked=true, result=result, immediate_replay=replay, immediate_present=after~=nil and after.valid, uid=identity.platformUid, failures=failures} end)()`,
	);
	check(driven.locked === true, "production transfer lock acquired", driven.err);
	for (const fault of asArray(driven.failures)) {
		check(fault.refused && fault.retained && fault.locked && !fault.receipt,
			`${fault.mode} evacuation retains body and source lock without a deletion receipt`, JSON.stringify(fault));
	}
	check(asArray(driven.failures).length === 3, "all evacuation fault modes executed");
	check(driven.result === "SUCCESS", "delete chokepoint returned SUCCESS", String(driven.result));
	console.log(`  immediate replay observation: ${JSON.stringify({result:driven.immediate_replay, platformPresent:driven.immediate_present})}`);
	// A separate RCON request observes the engine after the deletion callback has returned.
	const replay = rconJson(`{result=remote.call('surface_export','delete_platform_for_transfer',${setup.index},'${PROBE}','player','${PROBE}',${JSON.stringify(driven.uid)})}`);
	check(replay.result === "SUCCESS", "replayed deletion acknowledges the original result", String(replay.result));

	const after = rconJson(
		`(function() local present=false for _,q in pairs(game.forces.player.platforms) do if q.name=='${PROBE}' then present=true end end `
		+ `local units={} for _,c in pairs(game.surfaces['nauvis'].find_entities_filtered{type='character'}) do units[#units+1]=c.unit_number end `
		+ `return {platform_present=present, nauvis_units=units} end)()`,
	);
	check(after.platform_present === false, "probe platform fully deleted");
	check(asArray(after.nauvis_units).includes(bodyUnit),
		"the exact fixture body survives source deletion on Nauvis",
		`missing fixture body: ${bodyUnit}`);
	const destination = rconJson(
		`(function() local p=game.forces.player.create_space_platform{name='${PROBE}',planet='nauvis',starter_pack='space-platform-starter-pack'} p.apply_starter_pack() `
		+ `local body=game.get_entity_by_unit_number(${bodyUnit}) assert(body and body.valid) assert(body.teleport({2,3},p.surface)) `
		+ `local holds=package.loaded['__level__/modules/surface_export/core/destination-hold.lua'] `
		+ `local ok,err=holds.stage('${PROBE}-dest',p,game.forces.player,true,nil,'${PROBE}-job') assert(ok,err) return {index=p.index} end)()`,
	);
	probeIndex = destination.index;
	const discarded = rconJson(
		`(function() local holds=package.loaded['__level__/modules/surface_export/core/destination-hold.lua'] `
		+ `local gateway=package.loaded['__level__/modules/surface_export/core/gateway.lua'] local original=gateway.evacuate_passengers local failures={} `
		+ `for _,mode in ipairs({'refused','throw','missing'}) do gateway.evacuate_passengers=function() `
		+ `if mode=='throw' then error('injected evacuation error') end if mode=='missing' then return nil end return {success=false,failures=1} end `
		+ `local called,result=pcall(holds.discard,'${PROBE}-dest','${PROBE}-job') gateway.evacuate_passengers=original `
		+ `local p=game.forces.player.platforms[${probeIndex}] failures[#failures+1]={mode=mode,refused=called and result==false, `
		+ `held=holds.get('${PROBE}-dest')~=nil,retained=p~=nil and p.valid and p.surface.count_entities_filtered{type='character'}==1} end `
		+ `local ok,err=holds.discard('${PROBE}-dest','${PROBE}-job') return {failures=failures,deleted=ok,error=err,held=holds.get('${PROBE}-dest')~=nil} end)()`,
	);
	check(asArray(discarded.failures).length === 3, "all destination evacuation fault modes executed");
	for (const fault of asArray(discarded.failures)) check(fault.refused && fault.held && fault.retained,
		`${fault.mode} evacuation retains the failed destination, its hold and body`, JSON.stringify(fault));
	const survivor = rconJson(`(function() local body=game.get_entity_by_unit_number(${bodyUnit}) return {alive=body~=nil and body.valid, `
		+ `surface=body and body.surface.name,platform_present=game.forces.player.platforms[${probeIndex}]~=nil} end)()`);
	check(discarded.deleted && !discarded.held && survivor.alive && survivor.surface === "nauvis" && !survivor.platform_present,
		"destination retry evacuates the same body before deleting and clearing its hold");
} finally {
	try {
		const swept = rconJson(
			`(function() local plats=0 local refusals={} `
			+ `for _,q in pairs(game.forces.player.platforms) do if q.name=='${PROBE}' then `
			+ `local foreign=false for _,p in pairs(game.players) do if p.physical_surface_index==q.surface.index then foreign=true end end `
			+ `for _,c in pairs(q.surface.find_entities_filtered{type='character'}) do if c.unit_number~=${bodyUnit ?? "nil"} then foreign=true end end `
			+ `if foreign then refusals[#refusals+1]='foreign passenger on fixture' `
			+ `elseif q.surface and q.surface.valid then local index=q.index if game.delete_surface(q.surface) then `
			+ `plats=plats+1 if storage.locked_platforms then storage.locked_platforms[index]=nil end `
			+ `local hold=storage.destination_holds and storage.destination_holds['${PROBE}-dest'] `
			+ `if hold and hold.platform_index==index then storage.destination_holds['${PROBE}-dest']=nil end `
			+ `else refusals[#refusals+1]='fixture deletion refused' end end end end `
			+ `local chars=0 for _,c in pairs(game.surfaces['nauvis'].find_entities_filtered{type='character'}) do `
			+ `if c.unit_number==${bodyUnit ?? "nil"} and c.player == nil then if c.destroy() then chars=chars+1 end end end `
			+ `local lock_residue = false `
			+ (sourceIndex !== null
				? `for _,index in ipairs({${sourceIndex},${probeIndex ?? sourceIndex}}) do if storage.locked_platforms and storage.locked_platforms[index] ~= nil then lock_residue = true end end `
				: "")
			+ `return {platforms=plats, characters=chars, refusals=refusals, lock_residue=lock_residue} end)()`,
		);
		console.log(`  cleanup: swept ${swept.platforms} fixture platform(s), ${swept.characters} fixture character(s)`);
		for (const refusal of asArray(swept.refusals)) {
			failed++;
			console.error(`  FAIL unlock refused during sweep: ${refusal} — a lock record may be orphaned`);
		}
		check(swept.lock_residue === false,
			"zero leftovers: no storage.locked_platforms residue for both source and destination indices",
			"a lock record outlived its platform — persistent storage.* records are leftovers too");
		const remaining = rconJson(
			`(function() local remaining=0 for _,c in pairs(game.surfaces['nauvis'].find_entities_filtered{type='character'}) do `
			+ `if c.unit_number==${bodyUnit ?? "nil"} then remaining=remaining+1 end end return {chars=remaining} end)()`,
		);
		check(remaining.chars === 0, "zero leftovers: fixture character removed from Nauvis");
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
