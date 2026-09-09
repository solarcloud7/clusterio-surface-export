// Bounded crusher slot-cap experiment: original writes, inventory.insert and
// writable stack count. No world repair; every candidate is observed and cleaned up.
import assert from "node:assert/strict";
import {readFileSync, writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {withWorkflowLock} from "../../../tools/shared/workflow-lock.mjs";
import {docker, HOSTS, preflightState, assertLeaseClean, sleep} from "../../lab-gallery/batch-lifecycle.mjs";
const entity = JSON.parse(readFileSync(new URL("./crafter-input.json", import.meta.url), "utf8"));
assert.equal(entity.name, "crusher");
const name = `transfer-cleanup-crafter-${Date.now().toString(36)}`;
const file = `ci-artifacts/${name}.json`;
const prefix = `local name='${name}';local p;for _,v in pairs(game.forces.player.platforms) do if v.name==name then assert(not p);p=v end end;`;
function run(body) {
  const cmd = `/sc local ok,result=pcall(function() ${prefix} ${body} end);rcon.print(helpers.table_to_json(ok and result or {success=false,error=tostring(result)}))`;
  assert.ok(Buffer.byteLength(cmd) < 32768);
  const raw = docker(["exec", "surface-export-controller", "npx", "clusterioctl", "--config", "/clusterio/tokens/config-control.json",
    "--log-level", "error", "instance", "send-rcon", HOSTS[2].instance, cmd], {timeout: 20000, maxBuffer: 262144});
  const r = JSON.parse(raw.trim().split(/\r?\n/).at(-1)); assert.equal(r.success, true, r.error); return r;
}
const report = {entity, sourceHash: createHash("sha256").update(readFileSync(import.meta.filename)).digest("hex"), samples: []};
await withWorkflowLock(async () => {
  try {
    for (const host of [1, 2]) assertLeaseClean(host, preflightState(host), "crafter dormancy probe");
    report.build = run(`assert(script.active_mods.base=='2.1.17');assert(not p);
      p=assert(game.forces.player.create_space_platform{name=name,planet='nauvis',starter_pack='space-platform-starter-pack'});p.apply_starter_pack();p.paused=true;
      local tiles={};for x=5,25 do for y=5,15 do tiles[#tiles+1]={name='space-platform-foundation',position={x,y}} end end;p.surface.set_tiles(tiles);
      local ds=assert(package.loaded['__level__/modules/surface_export/core/deserializer.lua']);
      local states={};for i=1,3 do local data=helpers.json_to_table(${JSON.stringify(JSON.stringify(entity))});data.position={x=5*i+2,y=10};
        local e=assert(ds.create_entity(p.surface,data));local active=e.active;
        if i==2 or e.active then e.disabled_by_script=true end;
        ds.restore_entity_state(e,data);states[i]={initial_active=active,disabled=e.disabled_by_script};end;
      return {success=true,engine=script.active_mods.base,states=states}`);
    report.restore = run(`assert(p);local ds=assert(package.loaded['__level__/modules/surface_export/core/deserializer.lua']);local readings={};
      for i=1,3 do local e=assert(p.surface.find_entities_filtered{name='crusher',area={{5*i,8},{5*i+5,12}}}[1]);
        local data=helpers.json_to_table(${JSON.stringify(JSON.stringify(entity))});
        if i==3 then e.disabled_by_script=true end;
        ds.restore_inventories(e,data);e.disabled_by_script=true;
        local inventory=e.get_inventory(defines.inventory.crafter_input);
        if i==2 then inventory.insert{name='metallic-asteroid-chunk',count=2} end;
        if i==3 then inventory[1].count=9 end;
        readings[i]={count=e.get_inventory(defines.inventory.crafter_input).get_item_count('metallic-asteroid-chunk'),disabled=e.disabled_by_script,progress=e.crafting_progress};end;
      return {success=true,tick=game.tick,readings=readings}`);
    for (let i = 0; i < 3; i++) {
      await sleep(500);
      report.samples.push(run(`assert(p);local readings={};for i=1,3 do local e=assert(p.surface.find_entities_filtered{name='crusher',area={{5*i,8},{5*i+5,12}}}[1]);
        readings[i]={count=e.get_inventory(defines.inventory.crafter_input).get_item_count('metallic-asteroid-chunk'),disabled=e.disabled_by_script,progress=e.crafting_progress};end;
        return {success=true,tick=game.tick,readings=readings}`));
    }
    const readings = report.restore.readings;
    assert.equal(readings[0].count, 7, "the original clamp did not reproduce");
    assert.ok(report.samples.every(s => s.readings.every(r => r.count === 7)), "candidate behavior changed; inspect raw observations");
    report.verdict = "STOP";
    process.exitCode = 2;
    report.reason = "set_stack, inventory.insert and writable count all clamp this source stack from 9 to 7; no successful workaround";
  } catch (error) {report.verdict = "HARNESS_ERROR"; report.error = String(error); process.exitCode = 1;}
  finally {
    try {report.cleanup = run(`if p then assert(game.delete_surface(p.surface)) end;return {success=true}`);
      report.postflight = run(`assert(not p);return {success=true}`);
    } catch (error) {report.cleanup = {success: false, error: String(error)}; process.exitCode = 1;}
    writeFileSync(file, JSON.stringify(report)); console.log({artifact: file, verdict: report.verdict, reason: report.reason, error: report.error, cleanup: report.cleanup});
  }
});
