import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { lua, ctl, sleep, preflightState, assertLeaseClean, docker, instancePath, HOSTS } from "../../lab-gallery/batch-lifecycle.mjs";
import { readTransactionLogStore } from "../../../tools/tests/testkit/log-query.mjs";
import { withWorkflowLock } from "../../../tools/shared/workflow-lock.mjs";

// Two sequential production transfers of one disposable clone; optional profiled rejection.
// --reject-only runs just the rejected leg (a deleted source's surface index can be reused by the
// next clone, which makes its retained deletion receipt look unresolved to the lab preflight).
const profiled=process.argv.includes("--profile-batches"), rejectLast=process.argv.includes("--reject-last"), rejectOnly=process.argv.includes("--reject-only");
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
// The source's own log lines for this clone: the staggered belt capture and, after a rejection, the restore.
// Markers must not contain quotes: they are passed through a single-quoted shell argument.
const sourceLog=(host,marker,needle)=>docker(["exec",HOSTS[host].container,"sh","-c",
  `grep -aF '${marker}' '${instancePath(host,"factorio-current.log")}' || true`]).trim().split(/\r?\n/).filter(line=>line&&(!needle||line.includes(needle)));
function sourceBeltCapture(host,records) {
  const phase=records.find(r=>r.owner==="source-lua"&&r.id==="belt_capture"&&r.kind==="execution");
  assert.ok(phase,"source belt_capture stage missing");
  assert.ok(phase.batchCount>1&&phase.workTicks===phase.batchCount,"a transfer must capture its belts over several callbacks, one per tick");
  const done=sourceLog(host,"[Belt Scan] Staggered capture done for ",`'${name}'`).at(-1);
  assert.ok(done,"the source must log the staggered capture summary for this clone");
  const m=done.match(/(\d+) belt\(s\), (\d+) stack\(s\) \((\d+) picked up by the final sweep\), (\d+) side group\(s\) \((\d+) merged[^)]*\), \d+ slot\(s\)[^,]*, (\d+) callback\(s\) over (\d+) tick\(s\)/);
  assert.ok(m,`unparsed capture summary: ${done}`);
  const summary={belts:+m[1],stacks:+m[2],sweptStacks:+m[3],groups:+m[4],merged:+m[5],callbacks:+m[6],ticks:+m[7]};
  assert.equal(summary.callbacks+1,phase.batchCount,"the timing stage must cover the begin callback plus every capture callback");
  assert.ok(sourceLog(host,"contract violated").length===0,"no cleared item may reappear");
  const batches=records.filter(r=>r.owner==="source-lua"&&r.parent==="belt_capture");
  return {...summary,executionMs:phase.executionMs,maxCallbackMs:batches.length?Math.max(...batches.map(b=>b.executionMs)):null};
}
function sourceRestored(host) {
  const line=sourceLog(host,"captured belt item(s) onto ",`'${name}'`).at(-1);
  assert.ok(line&&line.includes("belt census after the restore matches the capture exactly"),
    `after a rejection the source must put its belt cargo back and pass the whole-belt census: ${line}`);
  assert.ok(sourceLog(host,"could not be put back").length===0,"no restore may have been refused");
  return +line.match(/Restored (\d+) captured belt item/)[1];
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
    const legs=rejectOnly?[[1,2,true]]:[[1,2,false],[2,1,false],...(rejectLast?[[1,2,true]]:[])];
    for(const [source,destination,reject]of legs) {
      assertLeaseClean(source,preflightState(source),"before roundtrip leg");
      const prior=new Set(readTransactionLogStore().map(e=>e.transferInfo.transferId));
      if(reject)lua(destination,`remote.call('surface_export','configure',{debug_mode=true,test_force_validation_failure=true}) return {ok=true}`);
      const reply=ctl("surface-export","start-transfer",String(ids[source]),String(getIndex(source)),String(ids[destination]));
      const entry=await until(()=>readTransactionLogStore().find(e=>e.transferInfo.platformName===name
        &&!prior.has(e.transferInfo.transferId)&&["completed","failed","error","cleanup_failed"].includes(e.transferInfo.status)),"terminal transfer verdict");
      result.legs.push({source,destination,reject,reply,entry});writeFileSync(artifact,JSON.stringify(result,null,2));
      assert.equal(entry.transferInfo.status,reject?"failed":"completed",JSON.stringify(entry.summary));
      const capture=sourceBeltCapture(source,entry.summary.timing.records);
      result.legs.at(-1).sourceBeltCapture=capture;
      if(reject) {
        assert.ok(entry.events.some(e=>e.eventType==="rollback_success"),"rollback acknowledgement required");
        assert.equal(typeof getIndex(source),"number","rejection must preserve source");
        assert.equal(getIndex(destination),undefined,"rejection must remove destination");
        const restored=sourceRestored(source);
        result.legs.at(-1).sourceRestoredItems=restored;
        const onBelts=lua(source,`local total=0 for _,p in pairs(game.forces.player.platforms) do if p.name=='${name}' then for _,e in ipairs(p.surface.find_entities_filtered{type={'transport-belt','underground-belt','splitter','loader','loader-1x1'}}) do for li=1,e.get_max_transport_line_index() do for _,c in ipairs(e.get_transport_line(li).get_contents()) do total=total+c.count end end end end end return {total=total}`).total;
        assert.equal(lua(source,`local n=0 for _ in pairs(storage.locked_platforms or {}) do n=n+1 end return {locks=n}`).locks,0,"the source must be unlocked after the rollback");
        console.log(JSON.stringify({rollback:{restoredItems:restored,onSourceBeltsNow:onBelts}}));
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
      console.log(JSON.stringify({sourceBeltCapture:capture}));
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
