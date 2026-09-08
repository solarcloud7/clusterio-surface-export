import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { lua, ctl, sleep, preflightState, assertLeaseClean } from "../../lab-gallery/batch-lifecycle.mjs";
import { readTransactionLogStore } from "../../../tools/tests/testkit/log-query.mjs";
import { withWorkflowLock } from "../../../tools/shared/workflow-lock.mjs";

// Two sequential production transfers of one disposable clone; optional profiled rejection.
const profiled=process.argv.includes("--profile-batches"), rejectLast=process.argv.includes("--reject-last");
const name=`belt-roundtrip-${Date.now()}`, ids={1:836570928,2:902099405};
const artifactArg=process.argv.indexOf("--artifact");
const artifact=artifactArg<0?(profiled?"ci-artifacts/belt-batching-roundtrip.json":"ci-artifacts/force-insert-roundtrip.json"):process.argv[artifactArg+1];
assert.ok(artifact&&resolve(artifact).startsWith(resolve("ci-artifacts")+sep)&&artifact.endsWith(".json"),
  "artifact must be a JSON file inside ci-artifacts");
const result={name,legs:[]}, previousConfig={};
const index=host=>lua(host,`local out={} for _,p in pairs(game.forces.player.platforms) do if p.name=='${name}' then out[#out+1]=p.index end end return {indexes=out}`).indexes;
const getIndex=host=>{const indexes=Object.values(index(host));assert.ok(indexes.length<=1);return indexes[0];};
async function until(read,why) {
  const deadline=Date.now()+150000;
  while(Date.now()<deadline) {const r=read();if(r)return r;await sleep(1000);}
  throw Error(`Timed out: ${why}`);
}
await withWorkflowLock(async()=>{
  for(const host of [1,2])assertLeaseClean(host,preflightState(host),"before belt roundtrip");
  try {
    for(const host of [1,2]) {
      previousConfig[host]=lua(host,`local c=storage.surface_export_config or {} return {profile_batches=c.profile_batches,debug_mode=c.debug_mode,test_force_validation_failure=c.test_force_validation_failure}`);
      assert.ok(!previousConfig[host].test_force_validation_failure,"refuse an already armed rejection hook");
      if(profiled)lua(host,`remote.call('surface_export','configure',{profile_batches=true}) return {ok=true}`);
    }
    const cloned=lua(1,`local source for _,p in pairs(game.forces.player.platforms) do if p.name=='lab-transfer-fixture-v1' then assert(not source,'ambiguous source');source=p end end assert(source,'source missing');return remote.call('surface_export','clone_platform',source.index,'${name}')`);
    result.clone=cloned;assert.ok(cloned.job_id,JSON.stringify(cloned));
    await until(()=>getIndex(1),"clone creation");
    await until(()=>preflightState(1).jobs===0,"clone completion");
    for(const [source,destination,reject]of [[1,2,false],[2,1,false],...(rejectLast?[[1,2,true]]:[])]) {
      assertLeaseClean(source,preflightState(source),"before roundtrip leg");
      const prior=new Set(readTransactionLogStore().map(e=>e.transferInfo.transferId));
      if(reject)lua(destination,`remote.call('surface_export','configure',{debug_mode=true,test_force_validation_failure=true}) return {ok=true}`);
      const reply=ctl("surface-export","start-transfer",String(ids[source]),String(getIndex(source)),String(ids[destination]));
      const entry=await until(()=>readTransactionLogStore().find(e=>e.transferInfo.platformName===name
        &&!prior.has(e.transferInfo.transferId)&&["completed","failed","error","cleanup_failed"].includes(e.transferInfo.status)),"terminal transfer verdict");
      result.legs.push({source,destination,reject,reply,entry});writeFileSync(artifact,JSON.stringify(result,null,2));
      assert.equal(entry.transferInfo.status,reject?"failed":"completed",JSON.stringify(entry.summary));
      if(reject) {
        assert.ok(entry.events.some(e=>e.eventType==="rollback_success"),"rollback acknowledgement required");
        assert.equal(typeof getIndex(source),"number","rejection must preserve source");
        assert.equal(getIndex(destination),undefined,"rejection must remove destination");
      } else {
        assert.equal(getIndex(source),undefined,"source must be deleted after completion");
        assert.equal(typeof getIndex(destination),"number","destination must exist");
      }
      if(profiled) {
        const records=entry.summary.timing.records;
        const phase=records.find(r=>r.owner==="destination-lua"&&r.id==="belts");
        const batches=records.filter(r=>r.owner==="destination-lua"&&r.parent==="belts");
        assert.ok(phase.batchCount>1,"fixture must exercise multiple belt callbacks");
        assert.equal(batches.length,phase.batchCount);
        assert.equal(phase.workTicks,phase.batchCount);
        assert.equal(phase.endTick-phase.startTick,phase.ticksElapsed);
        assert.ok(phase.ticksElapsed>=phase.batchCount-1);
        assert.ok(batches.every(b=>Number.isFinite(b.executionMs)&&b.executionMs>0&&b.startTick===b.endTick));
        assert.ok(phase.endMs-phase.startMs>=phase.executionMs,"phase envelope includes waits");
        const stage=id=>{
          const record=records.find(r=>r.owner==="destination-lua"&&r.clockId===phase.clockId&&r.id===id);
          assert.ok(record&&Number.isSafeInteger(record.startTick)&&Number.isSafeInteger(record.endTick),
            `missing tick boundaries for ${id}`);
          return record;
        };
        const stages=["tiles","beacons","entities","hub","belts","state","inventories","held_items","fluids"];
        for(let i=1;i<stages.length;i++) {
          assert.ok(stage(stages[i]).startTick>stage(stages[i-1]).endTick,
            `${stages[i-1]} must yield before ${stages[i]}`);
        }
        assert.equal(stage("hub_mapping").batchCount,1,"hub mapping must not repeat in every entity batch");
        assert.equal(stage("fluids").endTick,stage("exact_verification").startTick,
          "fluid writes and exact cargo gate must share a callback");
        if(!reject)assert.equal(stage("exact_verification").endTick,stage("activation").startTick,
          "activation must follow the gate without another simulation tick");
        result.legs.at(-1).phaseTicks=stages.map(id=>({id,start:stage(id).startTick,end:stage(id).endTick}));
        console.log(JSON.stringify({beltBatches:phase.batchCount,workTicks:phase.workTicks,
          elapsedTicks:phase.ticksElapsed,executionMs:phase.executionMs,
          maxCallbackMs:Math.max(...batches.map(b=>b.executionMs))}));
      }
      console.log(JSON.stringify({source,destination,id:entry.transferInfo.transferId,status:entry.transferInfo.status,import:entry.summary.import}));
    }
  } finally {
    result.cleanup={};
    for(const host of [1,2]) {
      if(previousConfig[host]) {
        const literal=value=>value===undefined?"nil":value===true?"true":"false";
        const c=previousConfig[host];
        lua(host,`local c=storage.surface_export_config c.profile_batches=${literal(c.profile_batches)} c.debug_mode=${literal(c.debug_mode)} c.test_force_validation_failure=${literal(c.test_force_validation_failure)} return {ok=true}`);
      }
      assertLeaseClean(host,preflightState(host),"before clone cleanup");
      lua(host,`for _,p in pairs(game.forces.player.platforms) do if p.name=='${name}' then game.delete_surface(p.surface) end end return {ok=true}`);
      assert.equal(getIndex(host),undefined);
      result.cleanup[host]=preflightState(host);
      assertLeaseClean(host,result.cleanup[host],"after roundtrip");
    }
    writeFileSync(artifact,JSON.stringify(result,null,2));
  }
});
