import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {lua,rcon,sleep,preflightState,assertLeaseClean,instanceIds} from '../../lab-gallery/batch-lifecycle.mjs';
import {withWorkflowLock} from '../../../tools/shared/workflow-lock.mjs';

const fixture=readFileSync(new URL('./constant-seed.lua',import.meta.url),'utf8');
const artifact=process.argv.find(arg=>arg.startsWith('--artifact='))?.slice('--artifact='.length)
  ?? 'ci-artifacts/latch-transfer-result.json';
const map=signals=>Object.fromEntries(Object.values(signals??{}).map(s=>[
  `${s.signal.type??'item'}|${s.signal.name}|${s.signal.quality??'normal'}`,s.count,
]));
function analyze(r){
  assert.equal(r.before.entities.length,4);
  assert.equal(r.after.entities.length,4);
  const memory=map(r.before.entities[1].register);
  assert.equal(Object.keys(memory).length,3);
  assert.ok(Object.values(memory).some(v=>v<0));
  assert.ok(Object.keys(memory).some(k=>k.endsWith('|rare')));
  for(let i=0;i<4;i++){
    assert.deepEqual(map(r.settled.entities[i].register),map(r.before.entities[i].register));
    assert.deepEqual(map(r.after.entities[i].register),map(r.before.entities[i].register));
    assert.deepEqual(r.after.entities[i].parameters,r.before.entities[i].parameters);
  }
  for(const i of [2,3])assert.deepEqual(map(r.before.entities[i].register),memory,'consumer chain must carry source memory before transfer');
  assert.equal(r.after.result.rearmed,2);
  assert.equal(r.after.result.failed,0);
  assert.equal(r.after.result.cleared,0);
  const timing=r.after.result;
  assert.ok(Number.isInteger(timing.scheduled_tick));
  assert.ok(Number.isInteger(timing.first_seed_tick));
  for(const item of Object.values(timing.details)){
    assert.equal(item.first_seed_status,'working','transferred fixture must be ready at its first seed callback');
    assert.equal(item.seed_tick,timing.first_seed_tick,'ready memory must not wait for power');
  }
  assert.equal(r.sourceAbsent,true);
  return {status:'PASS',reason:'full transfer preserved boolean latch, signed quality memory and both downstream decider registers with original rules',
    readinessTicks:timing.first_seed_tick-timing.scheduled_tick,
    restorationTicks:timing.finished_tick-timing.scheduled_tick};
}
if(process.argv.includes('--analyze')){
  console.log(JSON.stringify(analyze(JSON.parse(readFileSync(artifact)))));
}else await withWorkflowLock(async()=>{
  assert.equal(JSON.parse(readFileSync('ci-artifacts/latch-installed-result.json')).verdict?.status,'PASS');
  const start=performance.now(),name=`latch-baseline-transfer-${Date.now()}`;
  const report={name,mutationOccurred:false};
  const schema=JSON.parse(readFileSync('ci-artifacts/belt-boundary-api.json'));
  assert.equal(schema.application_version,'2.1.17');
  const manifest={LuaSurface:['find_entities_filtered'],LuaSpacePlatform:['index'],LuaEntity:['get_control_behavior','get_wire_connector'],LuaWireConnector:['connect_to']};
  for(const [type,names]of Object.entries(manifest))for(const name of names){
    const c=schema.classes.find(c=>c.name===type);
    assert.ok([...c.methods,...c.attributes].some(m=>m.name===name),`${type}.${name}`);
  }
  report.fingerprint=createHash('sha256').update(fixture).update(readFileSync(new URL(import.meta.url)))
    .update(readFileSync('docker/seed-data/external_plugins/surface_export/module/import_phases/latch_rearm.lua'))
    .update(JSON.stringify(manifest)).digest('hex');
  const run=mode=>lua(1,fixture.replaceAll('__NAME__',name).replaceAll('__MODE__',mode));
  const find=`local p for _,q in pairs(game.forces.player.platforms) do if q.name=='${name}' then p=q end end`;
  const observe=host=>lua(host,`${find}
    if not p then return {found=false} end
    local out={found=true,index=p.index,entities={}}
    for _,pos in ipairs({{8.5,3},{8.5,6},{16.5,9},{24.5,9}}) do
      local entities=p.surface.find_entities_filtered{type='decider-combinator',area={{pos[1]-1,pos[2]-1},{pos[1]+1,pos[2]+1}}}
      assert(#entities==1,'expected exactly one decider near '..helpers.table_to_json(pos))
      local e=entities[1]
      assert(e.valid and e.type=='decider-combinator','missing observed decider')
      local cb=e.get_control_behavior()
      out.entities[#out.entities+1]={position=e.position,register=cb.signals_last_tick,parameters=cb.parameters}
    end
    for _,r in pairs(storage.latch_rearm_results or {}) do if r.platform_name=='${name}' then out.result=r end end
    out.pending=false
    for _,r in pairs(storage.latch_rearm_jobs or {}) do if r.platform_name=='${name}' then out.pending=true end end
    return out`);
  const buildConsumers=()=>lua(1,`${find} assert(p,'missing fixture')
    local st=storage.__latch_baseline local wc=defines.wire_connector_id
    local previous=st.sources[2]
    for _,pos in ipairs({{16.5,9},{24.5,9}}) do
      local e=assert(p.surface.create_entity{name='decider-combinator',position=pos,force='player',direction=defines.direction.east})
      assert(e.type=='decider-combinator')
      e.get_control_behavior().parameters=st.rules[2]
      assert(previous.get_wire_connector(wc.combinator_output_green,true).connect_to(e.get_wire_connector(wc.combinator_input_green,true)), "consumer wire connection failed")
      previous=e
    end return {ok=true}`);
  const cleanup=()=>{
    for(const h of [1,2]){
      assertLeaseClean(h,preflightState(h),'before owned transfer fixture cleanup');
      const result=lua(h,`${find}
        for _,r in pairs(storage.latch_rearm_jobs or {}) do assert(r.platform_name~='${name}','restoration still pending') end
        if p then game.delete_surface(p.surface) end
        for k,r in pairs(storage.latch_rearm_results or {}) do if r.platform_name=='${name}' then storage.latch_rearm_results[k]=nil end end
        if storage.__latch_baseline then assert(storage.__latch_baseline.name=='${name}','foreign fixture storage'); storage.__latch_baseline=nil end
        return {ok=true}`);
      assert.equal(result.ok,true);
      assert.equal(observe(h).found,false);
      assert.equal(lua(h,'return {absent=storage.__latch_baseline == nil}').absent,true);
    }
  };
  for(const h of [1,2]){
    assertLeaseClean(h,preflightState(h),'before memory transfer');
    assert.equal(lua(h,'return {pending=table_size(storage.latch_rearm_jobs or {})}').pending,0);
  }
  try{
    report.mutationOccurred=true;
    assert.equal(run('build').engine,'2.1.17');report.construction=buildConsumers();assert.equal(report.construction.ok,true,JSON.stringify(report.construction));
    const fault=lua(1,"error('owned transfer constructor cleanup proof')");
    assert.match(fault.error,/owned transfer constructor cleanup proof/);
    cleanup();report.failureCleanup=true;
    assert.equal(run('build').engine,'2.1.17');report.construction=buildConsumers();assert.equal(report.construction.ok,true,JSON.stringify(report.construction));
    await sleep(1500);assert.equal(run('remove-seeds').ok,true);
    await sleep(500);report.settled=observe(1);
    await sleep(500);report.before=observe(1);
    assert.equal(report.before.found,true);
    const ids=instanceIds();
    report.request=rcon(1,`/transfer-platform ${report.before.index} ${ids[2]}`);
    assert.match(report.request,/Export queued:/,'transfer command must acknowledge admission');
    for(let i=0;i<45;i++){
      await sleep(1000);const after=observe(2);
      if(after.result&&!after.pending){report.after=after;break;}
    }
    assert.ok(report.after,'no restoration completion within 45 polls');
    report.sourceAbsent=observe(1).found===false;
    report.verdict=analyze(report);console.log(JSON.stringify(report.verdict));
  }catch(error){report.verdict={status:'HARNESS_ERROR',error:error.message};throw error;}
  finally{
    try{cleanup();report.cleanup=true;}
    finally{report.wallMs=performance.now()-start;writeFileSync(artifact,JSON.stringify(report,null,2));}
  }
});
