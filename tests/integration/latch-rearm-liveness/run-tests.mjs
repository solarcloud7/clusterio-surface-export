#!/usr/bin/env node
// Requires the installed module and an idle host-2. Exercises the production stage machine
// with one powered and one unpowered self-feedback decider on owned platforms.
// Independently reads exact signals and original parameters; no helper supplies memory.
// Does not replace the full-transfer circuit-memory fixture or measure wall-time performance.
import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {lua, sleep, preflightState, assertLeaseClean} from '../../lab-gallery/batch-lifecycle.mjs';
import {withWorkflowLock} from '../../../tools/shared/workflow-lock.mjs';

const tag=`latchlive-${Date.now()}`;
const names=[`${tag}-lit`,`${tag}-dark`];
const artifact='ci-artifacts/latch-readiness-liveness.json';
const cells=`local cells=storage.__latchlive_readiness assert(cells and cells.tag=='${tag}','foreign or missing fixture')`;
const map=signals=>Object.fromEntries(Object.values(signals??{}).map(s=>[s.signal.name,s.count]));
const construct=`
  assert(not storage.__latchlive_readiness,'foreign fixture storage')
  local cells={tag='${tag}',items={}} storage.__latchlive_readiness=cells
  for i,name in ipairs({'${names[0]}','${names[1]}'}) do
    local p=assert(game.forces.player.create_space_platform{name=name,planet='nauvis',starter_pack='space-platform-starter-pack'})
    local item={platform=p} cells.items[i]=item p.apply_starter_pack()
    local tiles={} for x=5,13 do for y=0,7 do tiles[#tiles+1]={name='space-platform-foundation',position={x,y}} end end
    p.surface.set_tiles(tiles)
    if i==1 then assert(p.surface.create_entity{name='solar-panel',position={7.5,5.5},force='player'}) end
    local e=assert(p.surface.create_entity{name='decider-combinator',position={9.5,1.5},direction=defines.direction.east,force='player'})
    item.entity=e assert(e.type=='decider-combinator')
    local cb=e.get_control_behavior()
    cb.parameters={conditions={{first_signal={type='virtual',name='signal-S'},comparator='>',constant=0}},
      outputs={{signal={type='virtual',name='signal-S'},copy_count_from_input=true}},else_outputs={}}
    item.parameters=cb.parameters
    local wc=defines.wire_connector_id
    assert(e.get_wire_connector(wc.combinator_output_red,true).connect_to(e.get_wire_connector(wc.combinator_input_red,true)))
  end return {ok=true,engine=script.active_mods.base}`;
const snapshot=()=>lua(2,`${cells}
  local out={tick=game.tick,items={}}
  local statuses={} for k,v in pairs(defines.entity_status) do statuses[v]=k end
  for i,item in ipairs(cells.items) do
    local e=item.entity local cb=e.get_control_behavior()
    out.items[i]={status=statuses[e.status],signals=cb.signals_last_tick,parameters=cb.parameters,
      original=item.parameters,result=(storage.latch_rearm_results or {})[item.platform.name],
      pending=(storage.latch_rearm_jobs or {})[item.platform.name]~=nil}
  end return out`);
function analyze(report){
  const [lit,dark]=report.after.items;
  for(const item of [lit,dark]){
    assert.equal(item.pending,false);
    assert.deepEqual(item.parameters,item.original);
    assert.equal(item.result.cleared,0);
    assert.equal(item.result.first_seed_tick-item.result.scheduled_tick,2);
    assert.equal(item.result.finished_tick-item.result.scheduled_tick,6);
  }
  assert.equal(lit.result.rearmed,1); assert.equal(lit.result.failed,0);
  assert.deepEqual(map(lit.signals),{'signal-S':7});
  assert.equal(dark.result.rearmed,0); assert.equal(dark.result.failed,1);
  assert.deepEqual(map(dark.signals),{});
  const detail=Object.values(dark.result.details)[0];
  assert.ok(['no_power','low_power','not_plugged_in_electric_network'].includes(detail.first_seed_status));
  assert.match(detail.outcome,/decider not evaluating at restoration:/);
  assert.equal(detail.seed_tick,undefined);
  return {status:'PASS',restorationTicks:6,reason:'exact powered memory; unpowered failure without seed writes; original rules preserved'};
}
if(process.argv.includes('--analyze')){
  console.log(JSON.stringify(analyze(JSON.parse(readFileSync(artifact,'utf8')))));
}else await withWorkflowLock(async()=>{
  const start=performance.now(),report={tag,mutationOccurred:false,
    fingerprint:createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex')};
  assertLeaseClean(2,preflightState(2),'before circuit readiness');
  assert.equal(lua(2,'return {pending=table_size(storage.latch_rearm_jobs or {})}').pending,0);
  const cleanup=async()=>{
    const removed=lua(2,`local cells=storage.__latchlive_readiness
      if not cells then return {ok=true} end assert(cells.tag=='${tag}','foreign fixture storage')
      for _,item in ipairs(cells.items) do
        if item.platform and item.platform.valid then item.platform.destroy(0) end
      end return {ok=true}`);
    assert.equal(removed.ok,true);
    // Let production finalize removed entities; never erase a pending restoration job.
    for(let i=0;i<10;i++){
      const done=lua(2,`for _,name in ipairs({'${names[0]}','${names[1]}'}) do
        if (storage.latch_rearm_jobs or {})[name] then return {done=false} end end return {done=true}`);
      if(done.done)break;
      assert.ok(i<9,'owned restoration did not finalize after entity removal'); await sleep(100);
    }
    assert.equal(lua(2,`for _,name in ipairs({'${names[0]}','${names[1]}'}) do
      if storage.latch_rearm_results then storage.latch_rearm_results[name]=nil end
      for _,p in pairs(game.forces.player.platforms) do assert(p.name~=name,'fixture left behind') end end
      if storage.__latchlive_readiness then assert(storage.__latchlive_readiness.tag=='${tag}') end
      storage.__latchlive_readiness=nil return {ok=true}`).ok,true);
    assertLeaseClean(2,preflightState(2),'after circuit readiness');
  };
  try{
    report.mutationOccurred=true;
    const fault=lua(2,construct.replace('p.apply_starter_pack()',"error('owned construction fault')"));
    assert.match(fault.error,/owned construction fault/); await cleanup(); report.failureCleanup=true;
    report.construction=lua(2,construct); assert.equal(report.construction.ok,true,JSON.stringify(report.construction));
    assert.equal(report.construction.engine,'2.1.17');
    for(let i=0;i<20;i++){
      report.before=snapshot();
      if(report.before.items[0].status==='working')break;
      assert.ok(i<19,'powered fixture never became ready'); await sleep(100);
    }
    for(const item of report.before.items)assert.deepEqual(map(item.signals),{},'no pre-existing memory or helper signal');
    assert.equal(lua(2,`${cells}
      local module=assert(package.loaded['__level__/modules/surface_export/import_phases/latch_rearm.lua'])
      local wc=defines.wire_connector_id
      for _,item in ipairs(cells.items) do
        local e=item.entity local id=e.unit_number
        assert(module.schedule({job_id=item.platform.name,platform_name=item.platform.name,entity_map={[id]=e},
          entities_to_create={{type='decider-combinator',entity_id=id,position=e.position,
            control_behavior={parameters=item.parameters},
            circuit_connections={{target_entity_id=id,source_circuit_id=wc.combinator_output_red,target_circuit_id=wc.combinator_input_red}},
            specific_data={output_signals={{signal={type='virtual',name='signal-S'},count=7}}}}}})==1)
      end return {ok=true}`).ok,true);
    for(let i=0;i<20;i++){
      report.after=snapshot();
      if(report.after.items.every(item=>item.result&&!item.pending))break;
      assert.ok(i<19,'restoration did not finish within bounded observation'); await sleep(100);
    }
    report.verdict=analyze(report); console.log(JSON.stringify(report.verdict));
  }catch(error){report.verdict={status:'FAIL',error:error.message};throw error;}
  finally{
    try{await cleanup();report.cleanup=true;}
    finally{report.wallMs=performance.now()-start;mkdirSync('ci-artifacts',{recursive:true});writeFileSync(artifact,JSON.stringify(report,null,2));}
  }
});
