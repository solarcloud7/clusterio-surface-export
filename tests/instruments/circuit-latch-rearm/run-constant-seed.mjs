import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {lua,sleep,preflightState,assertLeaseClean} from '../../lab-gallery/batch-lifecycle.mjs';
import {withWorkflowLock} from '../../../tools/shared/workflow-lock.mjs';
const source=readFileSync(new URL('./constant-seed.lua',import.meta.url),'utf8');
const candidate=process.argv.includes('--candidate');
const installed=process.argv.includes('--installed');
const artifact=installed?'ci-artifacts/latch-installed-result.json':candidate?'ci-artifacts/latch-constant-seed-result.json':'ci-artifacts/latch-baseline-reproduction.json';
const arr=x=>Object.values(x??{});
const map=signals=>Object.fromEntries(arr(signals).map(s=>[`${s.signal.type??'item'}|${s.signal.name}|${s.signal.quality??'normal'}`,s.count]));
function analyze(r){
  const before=r.before,after=r.after;
  assert.equal(before.sources.length,2);
  for(const s of before.sources)assert.ok(Object.keys(map(s.register)).length>0,'source must carry memory');
  assert.equal(Object.keys(map(before.sources[1].register)).length,3,'multi-signal signed/quality source');
  assert.ok(Object.values(map(before.sources[1].register)).some(v=>v<0));
  assert.ok(Object.keys(map(before.sources[1].register)).some(k=>k.endsWith('|rare')));
  for(let i=0;i<2;i++){
    assert.deepEqual(map(r.settled.sources[i].register),map(before.sources[i].register),'source must hold after seeds are removed');
    assert.deepEqual(map(after.sources[i].register),map(before.sources[i].register),'source changed during test');
  }
  let reproduced=0,controls=0;
  for(const row of after.destinations){
    const old=before.destinations.find(x=>x.case===row.case&&x.repetition===row.repetition);
    assert.deepEqual(map(old.state.register),{},'fresh destination must start empty');
    assert.deepEqual(row.state.parameters,before.sources[row.case-1].parameters,'original parameters must be restored');
    assert.deepEqual(map(row.state.network),map(row.state.register),'independent wire readback must agree');
    if(row.case===1){assert.deepEqual(map(row.state.register),map(before.sources[0].register));controls++;}
    else {assert.deepEqual(map(row.state.register),(r.candidate||r.installed)?map(before.sources[1].register):{});reproduced++;}
  }
  assert.equal(controls,3);assert.equal(reproduced,3);
  if(r.installed){
    assert.equal(after.result.rearmed,6);assert.equal(after.result.failed,0);assert.equal(after.result.cleared,0);
    return {status:'PASS',reason:'installed restoration preserves exact signed and quality memory in 3/3 destinations and 3/3 boolean controls',controls,reproduced};
  }
  if(r.candidate){
    for(const row of r.seededObservation.destinations){
      assert.deepEqual(map(row.state.register),map(before.sources[row.case-1].register),'temporary constants must match exact capture');
      assert.deepEqual(map(row.state.network),map(row.state.register));
    }
    return {status:'PASS',reason:'exact captured multi-signal memory survives original-rule restoration in 3/3 destinations; boolean control passes 3/3',controls,reproduced};
  }
  assert.equal(after.result.rearmed,3);assert.equal(after.result.cleared,3);
  return {status:'STOP',reason:'unchanged rearm loses captured nonzero memory in 3/3 destinations; boolean control passes 3/3',controls,reproduced};
}
if(process.argv.includes('--analyze')){console.log(JSON.stringify(analyze(JSON.parse(readFileSync(artifact)))));}
else await withWorkflowLock(async()=>{
  const started=performance.now();
  const schema=JSON.parse(readFileSync('ci-artifacts/belt-boundary-api.json'));
  assert.equal(schema.application_version,'2.1.17');
  if(candidate||installed){
    assert.equal(JSON.parse(readFileSync('ci-artifacts/latch-baseline-reproduction.json')).verdict?.status,'STOP','baseline must be reproduced first');
    const output=schema.concepts.find(c=>c.name==='DeciderCombinatorOutput');
    assert.equal(output.type.parameters.find(p=>p.name==='constant')?.type,'int32');
  }
  const manifest={LuaGameScript:['forces','tick','delete_surface'],LuaForce:['platforms','create_space_platform'],
    LuaSpacePlatform:['name','valid','surface','apply_starter_pack'],LuaSurface:['set_tiles','create_entity'],
    LuaEntity:['valid','type','unit_number','position','status','get_control_behavior','get_signals','get_wire_connector','destroy'],
    LuaDeciderCombinatorControlBehavior:['parameters','signals_last_tick'],LuaConstantCombinatorControlBehavior:['get_section','add_section'],
    LuaLogisticSection:['set_slot'],LuaWireConnector:['connect_to'],LuaBootstrap:['active_mods']};
  for(const [name,members]of Object.entries(manifest))for(const member of members){
    let c=schema.classes.find(c=>c.name===name),found=false;
    while(c){if([...c.methods,...c.attributes].some(m=>m.name===member))found=true;c=schema.classes.find(p=>p.name===c.parent);}
    assert.ok(found,`${name}.${member} absent from pinned API`);
  }
  const fingerprint=createHash('sha256').update(source).update(readFileSync(new URL(import.meta.url)))
    .update(readFileSync('docker/seed-data/external_plugins/surface_export/module/import_phases/latch_rearm.lua')).update(JSON.stringify(manifest)).digest('hex');
  const name=`latch-baseline-${Date.now()}`,result={fingerprint,manifest,name,candidate,installed,mutationOccurred:false};
  const run=mode=>{
    const body=source.replaceAll('__NAME__',name).replaceAll('__MODE__',mode);
    assert.ok(Buffer.byteLength(body)<16000);
    const r=lua(2,body);assert.ok(Buffer.byteLength(JSON.stringify(r))<128*1024);return r;
  };
  const clean=()=>{assert.equal(run('cleanup').ok,true);const x=lua(2,`local n=0 for _,p in pairs(game.forces.player.platforms) do if p.name=='${name}' then n=n+1 end end return {platforms=n,storage=storage.__latch_baseline~=nil,pending=(storage.latch_rearm_jobs or {})['${name}']~=nil}`);assert.deepEqual(x,{platforms:0,storage:false,pending:false});return x;};
  for(const h of[1,2])assertLeaseClean(h,preflightState(h),'before latch baseline');
  const guard=lua(2,`return {pending=table_size(storage.latch_rearm_jobs or {}),storage=storage.__latch_baseline~=nil}`);
  assert.equal(guard.pending,0);assert.equal(guard.storage,false);
  try{
    result.mutationOccurred=true;
    const proof=run('cleanup-proof');assert.match(proof.error,/owned cleanup proof/);
    result.failureCleanup=clean();
    result.built=run('build');assert.equal(result.built.engine,'2.1.17');assert.equal(result.built.built,true);
    await sleep(1500);
    result.seedRemoved=run('remove-seeds');assert.equal(result.seedRemoved.ok,true);
    await sleep(500);result.settled=run('observe');
    await sleep(500);result.before=run('observe');
    for(const s of [...result.before.sources,...result.before.destinations.map(x=>x.state)])assert.equal(s.status,'working','requires working decider');
    for(let i=0;i<2;i++)assert.deepEqual(map(result.settled.sources[i].register),map(result.before.sources[i].register));
    if(candidate){
      result.seed=run('candidate-seed');assert.equal(result.seed.seeded,6);
      await sleep(500);result.seededObservation=run('observe');
      result.restored=run('candidate-restore');assert.equal(result.restored.restored,6);
      await sleep(1000);result.after=run('observe');
    }else{
      result.scheduled=run('baseline');assert.equal(result.scheduled.scheduled,6);
      for(let i=0;i<45;i++){await sleep(1000);const r=run('observe');if(r.result&&!r.pending){result.after=r;break;}}
    }
    assert.ok(result.after,'no completion within 45 polls');
    result.verdict=analyze(result);console.log(JSON.stringify(result.verdict));
  }catch(error){result.verdict={status:'HARNESS_ERROR',error:error.message};throw error;}
  finally{try{result.cleanup=clean();result.postflight={};for(const h of[1,2]){result.postflight[h]=preflightState(h);assertLeaseClean(h,result.postflight[h],'after latch baseline');}}finally{result.wallMs=performance.now()-started;writeFileSync(artifact,JSON.stringify(result,null,2));}}
});
