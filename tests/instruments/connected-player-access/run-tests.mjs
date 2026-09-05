#!/usr/bin/env node
// requires: one consenting connected player on host 1; idle cluster; character or god controller
// produces: hidden-surface API readings and connected-passenger evacuation results
// does not: infer UI behavior from API calls or modify the original character's inventory
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { lua, preflightState, assertLeaseClean, sleep } from "../../lab-gallery/batch-lifecycle.mjs";

const action = process.argv[2] || "measure";
function analyze(report) {
	assert.equal(report.success, true, report.error);
	assert.equal(report.action, "measure", "UI observations cannot certify evacuation");
	assert.equal(report.engine, "2.1.17");
	assert.equal(report.cleanup.ok, true, JSON.stringify(report.cleanup));
	assert.equal(Object.keys(report.residue.names).length, 0);
	assert.equal(report.residue.view_record, false);
	assert.equal(report.residue.inventory_backup, false);
	assert.equal(report.arms.length, 2);
	assert.deepEqual(report.arms.map(arm => arm.remote_view), [false, true]);
	for (const arm of report.arms) {
		assert.equal(arm.teleport_into_hidden, true);
		assert.equal(arm.physical_aboard, true);
		assert.equal(arm.script_remote_view_into_hidden, true);
		assert.equal(arm.passenger_detected, true);
		assert.equal(arm.characters_aboard, 1);
		assert.equal(arm.delete_result, "SUCCESS");
		assert.equal(arm.character_valid, true);
		assert.equal(arm.character_surface, "nauvis");
		assert.equal(arm.physical_after, "nauvis");
		assert.equal(arm.platform_remaining, false);
		assert.equal(arm.lock_remains, false);
	}
	assert.deepEqual(report.after, report.before);
}
if (action === "--analyze") {
	analyze(JSON.parse(readFileSync(process.argv[3], "utf8")));
	console.log("PASS");
	process.exit(0);
}
assert.ok(["measure", "view", "hide", "hide-platform", "leave", "cleanup"].includes(action));
const state = preflightState(1);
assert.equal(state.players, 1, "requires exactly one consenting connected player");
assertLeaseClean(1, { ...state, players: 0 }, "connected-player-access");
const name = `player-access-${Date.now().toString(36)}`;
const common = `
local player=game.connected_players[1]
assert(player and player.connected,'player disconnected')
local created={}
local function snapshot()
 return {controller=player.controller_type,view=player.surface.name,physical=player.physical_surface.name,
   position=player.position,physical_position=player.physical_position,character=player.character and player.character.unit_number}
end
local function restore(before,character)
 if before.controller==defines.controllers.character then
  assert(character and character.valid,'original character missing')
  player.set_controller{type=defines.controllers.god}
  assert(player.teleport(character.position,character.surface),'original character surface not restored')
  player.set_controller{type=defines.controllers.character,character=character}
  assert(player.character==character,'original character not restored')
 else
  player.set_controller{type=defines.controllers.god}
  assert(player.teleport(before.position,before.view),'original god position not restored')
 end
end
local function require_supported_controller()
 assert(player.controller_type==defines.controllers.character or player.controller_type==defines.controllers.god,'character or god controller required')
 assert(not player.vehicle,'leave the vehicle before the lab')
 assert(not player.cursor_stack or not player.cursor_stack.valid_for_read,'empty the cursor before the lab')
end
local function keep_god_inventory()
 assert(not storage.issue69_player_inventory,'inventory backup exists; restore it before another run')
 if player.controller_type~=defines.controllers.god then return end
 local inv=player.get_main_inventory()
 if not inv then return end
 local rec={player=player.index,inventory=game.create_inventory(#inv),filters={},moved={}}
 storage.issue69_player_inventory=rec
 if inv.supports_bar() then rec.bar=inv.get_bar() end
 for i=1,#inv do
  if inv.supports_filters() then rec.filters[i]=inv.get_filter(i) end
  if inv[i].valid_for_read then
   assert(rec.inventory[i].swap_stack(inv[i]),'inventory preservation failed at '..i)
   rec.moved[i]=true
  end
 end
end
local function restore_inventory()
 local rec=storage.issue69_player_inventory
 if not rec then return end
 assert(rec.player==player.index,'inventory belongs to another player')
 local inv=player.get_main_inventory()
 assert(inv and #inv==#rec.inventory,'inventory size changed; backup retained')
 for i=1,#inv do
  if inv.supports_filters() then assert(inv.set_filter(i,rec.filters[i]),'filter restore refused') end
  if rec.moved[i] then
   assert(not inv[i].valid_for_read,'occupied restore slot; backup retained')
   assert(inv[i].swap_stack(rec.inventory[i]),'stack restore refused; backup retained')
   rec.moved[i]=nil
  end
 end
 if rec.bar then inv.set_bar(rec.bar) end
 assert(rec.inventory.is_empty(),'backup still contains items')
 rec.inventory.destroy()
 storage.issue69_player_inventory=nil
end
local function create(name)
 local p=player.force.create_space_platform{name=name,planet='nauvis',starter_pack='space-platform-starter-pack'}
 assert(p,'platform creation failed')
 created[#created+1]=p
 p.apply_starter_pack(); p.paused=true
 return p
end
`;
let body;
if (action === "view") {
	body = `
assert(not storage.issue69_player_view,'view fixture already exists; cleanup first')
require_supported_controller()
local rec={player=player.index,character=player.character,before=snapshot()}
storage.issue69_player_view=rec
local ok,err=pcall(function()
 keep_god_inventory()
 rec.platform=create('${name}')
 player.force.set_surface_hidden(rec.platform.surface,false)
 player.set_controller{type=defines.controllers.remote,surface=rec.platform.surface,position={0,0}}
end)
if not ok then
 restore(rec.before,rec.character)
 restore_inventory()
 for _,p in ipairs(created) do if p.valid then game.delete_surface(p.surface) end end
 storage.issue69_player_view=nil
 error(err)
end
return {success=true,action='view',platform=rec.platform.name,before=rec.before,after=snapshot(),hidden=player.force.get_surface_hidden(rec.platform.surface)}
`;
} else if (["hide", "hide-platform", "leave"].includes(action)) {
	body = `
local rec=storage.issue69_player_view
assert(rec and rec.player==player.index and rec.platform.valid,'owned view fixture missing')
local before=snapshot()
${action === "hide" ? "player.force.set_surface_hidden(rec.platform.surface,true)" : action === "hide-platform" ? "rec.platform.hidden=true" : "player.set_controller{type=defines.controllers.remote,surface='nauvis',position=rec.before.position}"}
return {success=true,action='${action}',platform=rec.platform.name,before=before,after=snapshot(),hidden=player.force.get_surface_hidden(rec.platform.surface),platform_hidden=rec.platform.hidden,admin=player.admin}
`;
} else if (action === "cleanup") {
	body = `
local rec=storage.issue69_player_view
assert(rec and rec.player==player.index,'owned view fixture missing')
restore(rec.before,rec.character)
restore_inventory()
if rec.platform and rec.platform.valid then assert(game.delete_surface(rec.platform.surface),'delete refused') end
storage.issue69_player_view=nil
return {success=true,action='cleanup',before=rec.before,after=snapshot(),original_character=player.character==rec.character}
`;
} else {
	body = `
assert(not storage.issue69_player_view,'finish the view fixture first')
require_supported_controller()
local original=player.character
local before=snapshot()
local force=player.force
local platforms,bodies,arms=created,{},{}
local deleted={}
local ok,err=pcall(function()
 keep_god_inventory()
 local gateway=package.loaded['__level__/modules/surface_export/core/gateway.lua']
 assert(gateway and gateway.collect_passengers,'Gateway not loaded')
 for _,remoteView in ipairs({false,true}) do
  local p=create('${name}'..(remoteView and '-remote' or '-character'))
  local character=game.surfaces.nauvis.create_entity{name='character',position=force.get_spawn_position('nauvis'),force=force}
  assert(character,'test character creation failed'); bodies[#bodies+1]=character
  player.set_controller{type=defines.controllers.god}
  assert(player.teleport(character.position,character.surface),'test character surface not reached')
  player.set_controller{type=defines.controllers.character,character=character}
  if ${process.argv.includes("--fail-after-build")} then error('injected failure after construction') end
  force.set_surface_hidden(p.surface,true)
  p.hidden=true
  local teleported=player.teleport({2,3},p.surface)
  local physical=player.physical_surface_index==p.surface.index
  assert(teleported and physical,'script teleport into hidden surface failed')
  player.set_controller{type=defines.controllers.remote,surface=p.surface,position={2,3}}
  local remoteAllowed=player.surface.index==p.surface.index
  player.set_controller{type=defines.controllers.character,character=character}
  if remoteView then player.set_controller{type=defines.controllers.remote,surface='nauvis',position=before.position} end
  local aboard,chars=gateway.collect_passengers(p)
  local passenger=false
  for _,candidate in ipairs(aboard) do if candidate.index==player.index then passenger=true end end
  assert(passenger and chars==1,'connected passenger was missed')
  local locked,why=remote.call('surface_export','lock_platform_for_transfer',p.index,force.name)
  assert(locked,why)
  local index=p.index
  local result=remote.call('surface_export','delete_platform_for_transfer',index,p.name,force.name,nil)
  if result=='SUCCESS' then deleted[index]=true end
  arms[#arms+1]={remote_view=remoteView,teleport_into_hidden=teleported,physical_aboard=physical,
    script_remote_view_into_hidden=remoteAllowed,
    passenger_detected=passenger,characters_aboard=chars,delete_result=result,
    character_valid=character.valid,character_surface=character.valid and character.surface.name,
    physical_after=player.physical_surface.name,platform_index=index,
    lock_remains=storage.locked_platforms and storage.locked_platforms[index]~=nil or false}
  restore(before,original)
 end
end)
local cleanupErrors={}
local restored,restoreErr=pcall(function()
 restore(before,original)
 restore_inventory()
end)
if not restored then cleanupErrors[#cleanupErrors+1]=tostring(restoreErr) end
if restored then
 for _,p in ipairs(platforms) do if p.valid and not deleted[p.index] then
  local cleaned,why=pcall(function()
   if storage.locked_platforms and storage.locked_platforms[p.index] then
    local unlocked,reason=remote.call('surface_export','unlock_platform',p.index)
    assert(unlocked~=false,reason)
   end
   assert(game.delete_surface(p.surface),'delete refused')
  end)
  if not cleaned then cleanupErrors[#cleanupErrors+1]=tostring(why) end
 end end
 for _,c in ipairs(bodies) do if c.valid then
  local cleaned,why=pcall(function() assert(c.destroy(),'body delete refused') end)
  if not cleaned then cleanupErrors[#cleanupErrors+1]=tostring(why) end
 end end
end
return {success=ok,action='measure',error=not ok and tostring(err) or nil,arms=arms,before=before,after=snapshot(),
 cleanup={ok=#cleanupErrors==0,errors=cleanupErrors},engine=script.active_mods.base,mods=script.active_mods}
`;
}
const report = lua(1, common + body);
report.fixtureSha256 = createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex");
if (action === "measure" || action === "cleanup") {
	await sleep(100);
	const residue = lua(1, `local names={} for _,p in pairs(game.forces.player.platforms) do if string.sub(p.name,1,14)=='player-access-' then names[#names+1]=p.name end end return {names=names,view_record=storage.issue69_player_view~=nil,inventory_backup=storage.issue69_player_inventory~=nil}`);
	report.residue = residue;
	for (const arm of Object.values(report.arms || {})) {
		const status = lua(1, `return {remaining=game.forces.player.platforms[${arm.platform_index}]~=nil}`);
		assert.equal(typeof status.remaining, "boolean", JSON.stringify(status));
		arm.platform_remaining = status.remaining;
	}
}
try {
	assert.equal(report.success, true, report.error);
	if (report.residue) {
		assert.equal(Object.keys(report.residue.names).length, 0, JSON.stringify(report.residue));
		assert.equal(report.residue.view_record, false);
		assert.equal(report.residue.inventory_backup, false);
		assertLeaseClean(1, { ...preflightState(1), players: 0 }, "connected-player-access cleanup");
	}
	if (action === "measure") {
		analyze(report);
	}
	report.verdict = action === "measure" ? "PASS" : "OBSERVATION";
} catch (error) {
	report.verdict = !report.success || report.cleanup?.ok === false
		|| (report.residue && (Object.keys(report.residue.names).length
			|| report.residue.view_record || report.residue.inventory_backup)) ? "HARNESS_ERROR" : "STOP";
	report.analysisError = error.message;
	process.exitCode = 1;
}
mkdirSync("ci-artifacts", { recursive: true });
writeFileSync(`ci-artifacts/${name}-${action}.json`, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
