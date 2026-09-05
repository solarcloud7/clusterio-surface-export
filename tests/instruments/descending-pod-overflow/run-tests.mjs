#!/usr/bin/env node
// requires: idle localhost host (default 1); Factorio 2.1.17; loaded SurfaceLock
// produces: real pod states and physical hub/ground counts for empty/full hub arms
// does not: certify hold duration, natural flight timing, or other cargo destinations
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { lua, preflightState, assertLeaseClean, sleep } from "../../lab-gallery/batch-lifecycle.mjs";

function analyze(report) {
	assert.equal(report.success, true, report.error);
	assert.equal(report.cleanup.ok, true, JSON.stringify(report.cleanup));
	assert.equal(Object.keys(report.cleanup.remainingSurfaces).length, 0);
	assert.equal(Object.keys(report.cleanup.remainingPlatforms).length, 0);
	assert.equal(report.engine, "2.1.17");
	assert.deepEqual(report.arms.map(arm => arm.full), [false, true]);
	for (const arm of report.arms) {
		assert.ok(["descending", "parking"].includes(arm.state), `not a descending specimen: ${arm.state}`);
		assert.equal(arm.before.copper, 100);
		assert.equal(arm.after.pods, 0);
		assert.equal(arm.after.hubIron, arm.before.hubIron);
		assert.equal(arm.after.hubCopper, arm.full ? 0 : 100);
		assert.equal(arm.after.groundCopper, arm.full ? 100 : 0);
		assert.equal(arm.after.hubCopper + arm.after.groundCopper, 100);
	}
	assert.equal(report.arms.length, 2);
	return "PASS";
}

const analysisIndex = process.argv.indexOf("--analyze");
if (analysisIndex >= 0) {
	console.log(analyze(JSON.parse(readFileSync(process.argv[analysisIndex + 1], "utf8"))));
} else {
	const hostIndex = process.argv.indexOf("--host");
	const host = hostIndex < 0 ? 1 : Number(process.argv[hostIndex + 1]);
	assert.ok([1, 2].includes(host), "--host must be 1 or 2");
	const name = `pod-overflow-${Date.now().toString(36)}`;
	assertLeaseClean(host, preflightState(host), name);
	const report = lua(host, `
local prefix='${name}'
local surfaces={}
local platforms={}
local arms={}
local ok,err=pcall(function()
  local lock=package.loaded['__level__/modules/surface_export/utils/surface-lock.lua']
  assert(lock and lock.complete_cargo_pods,'SurfaceLock not loaded')
  for _,full in ipairs({false,true}) do
    local suffix=full and '-full' or '-empty'
    local origin=game.create_surface(prefix..suffix..'-origin',{width=32,height=32})
    surfaces[#surfaces+1]=origin
    local p=game.forces.player.create_space_platform{name=prefix..suffix,planet='nauvis',starter_pack='space-platform-starter-pack'}
    assert(p,'platform creation failed')
    platforms[#platforms+1]=p
    p.apply_starter_pack()
    p.paused=true
    if ${process.argv.includes("--fail-after-build")} then error('injected failure after construction') end
    local hub=p.hub
    local inv=hub.get_inventory(defines.inventory.hub_main)
    inv.clear()
    if full then for i=1,#inv do assert(inv[i].set_stack{name='iron-plate',count=100}) end end
    local beforeIron=inv.get_item_count('iron-plate')
    local pod=origin.create_entity{name='cargo-pod',position={0,0},force='player'}
    assert(pod and pod.type=='cargo-pod','pod construction failed')
    local cargo=pod.get_inventory(defines.inventory.cargo_unit)
    assert(cargo.insert{name='copper-plate',count=100}==100)
    pod.cargo_pod_destination={type=defines.cargo_destination.station,station=hub}
    pod.force_finish_ascending()
    local arrivals=p.surface.find_entities_filtered{name='cargo-pod'}
    assert(#arrivals==1,'expected one physical pod at destination')
    pod=arrivals[1]
    local state=pod.cargo_pod_state
    assert(state=='descending' or state=='parking','wrong physical pod state: '..tostring(state))
    local before={copper=pod.get_inventory(defines.inventory.cargo_unit).get_item_count('copper-plate'),hubIron=beforeIron}
    lock.complete_cargo_pods(p.surface,hub)
    local ground=0
    for _,e in pairs(p.surface.find_entities_filtered{type='item-entity'}) do
      if e.stack.valid_for_read and e.stack.name=='copper-plate' then ground=ground+e.stack.count end
    end
    arms[#arms+1]={full=full,state=state,before=before,after={
      pods=p.surface.count_entities_filtered{name='cargo-pod'},hubIron=inv.get_item_count('iron-plate'),
      hubCopper=inv.get_item_count('copper-plate'),groundCopper=ground}}
  end
end)
local cleanupErrors={}
for _,p in ipairs(platforms) do
  local done,why=pcall(function()
    if p.valid and p.surface and p.surface.valid then assert(game.delete_surface(p.surface),'platform surface delete refused') end
  end)
  if not done then cleanupErrors[#cleanupErrors+1]=tostring(why) end
end
for _,s in ipairs(surfaces) do
  local done,why=pcall(function() if s.valid then assert(game.delete_surface(s),'delete refused') end end)
  if not done then cleanupErrors[#cleanupErrors+1]=tostring(why) end
end
return {success=ok,error=not ok and tostring(err) or nil,arms=arms,engine=script.active_mods.base,
  mods=script.active_mods,cleanup={ok=#cleanupErrors==0,errors=cleanupErrors}}
`);
	report.fixtureSha256 = createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex");
	await sleep(100);
	try {
		const residue = lua(host, `local names,platforms={},{} for _,s in pairs(game.surfaces) do if string.sub(s.name,1,${name.length})=='${name}' then names[#names+1]=s.name end end for _,p in pairs(game.forces.player.platforms) do if string.sub(p.name,1,${name.length})=='${name}' then platforms[#platforms+1]={name=p.name,index=p.index} end end return {names=names,platforms=platforms}`);
		report.cleanup.remainingSurfaces = residue.names;
		report.cleanup.remainingPlatforms = residue.platforms;
		assert.equal(Object.keys(residue.names).length, 0, JSON.stringify(residue));
		assert.equal(Object.keys(residue.platforms).length, 0, JSON.stringify(residue));
		assertLeaseClean(host, preflightState(host), `${name} cleanup`);
		report.verdict = analyze(report);
	} catch (error) {
		report.verdict = !report.success || !report.cleanup.ok
			|| Object.keys(report.cleanup.remainingSurfaces || {}).length
			|| Object.keys(report.cleanup.remainingPlatforms || {}).length ? "HARNESS_ERROR" : "STOP";
		report.analysisError = error.message;
		process.exitCode = 1;
	}
	mkdirSync("ci-artifacts", { recursive: true });
	writeFileSync(`ci-artifacts/${name}.json`, JSON.stringify(report, null, 2) + "\n");
	console.log(JSON.stringify(report, null, 2));
}
