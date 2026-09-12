import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import vm from "node:vm";
import { analyze, performanceCargo } from "./oracle.mjs";
import { DockerLab } from "./docker-lab.mjs";
import { destinationRollbackCase, loadDestinationCheckpoint } from "./destination-rollback.mjs";
import { importMutation } from "../../../tools/tests/testkit/mutation-run.mjs";

const run="se-manual-destination-offline";
const absent=()=>({present:false,tick:10});
const copy=()=>({present:true,usable:true,tick:10,platformHidden:false,surfaceHidden:false,
  locked:false,held:false,canary:{active:true,disabled:false},cargo:performanceCargo(0)});
const sample=()=>({source:absent(),destination:copy()});
function report() {
  const name=`transfer-cleanup-${run}-restore-old-destination`,transferId=`1:${name}`;
  const outcome={transferId,status:"completed"};
  const checkpoints=Object.fromEntries(["before","after"].map((generation,i)=>[generation,
    {host:2,name:`manual-destination-${generation}`,sha256:String(i+1).repeat(64),marker:{run,generation}}]));
  const contract=JSON.parse(readFileSync(new URL("contract.json",import.meta.url)));
  return {schemaVersion:1,contract,case:"restore-old-destination",run,name,transferId,
    cleanup:{success:true},before:copy(),initial:{source:copy(),destination:absent()},checkpoints,
    outcome,transferred:sample(),control:{load:structuredClone(checkpoints.after),reconciliationReady:true,sample:sample(),outcome},
    rollback:{load:structuredClone(checkpoints.before),observedMs:65010,
      samples:[0,65000].map(offsetMs=>({...sample(),outcome,offsetMs}))},
    events:{1:[],2:[{kind:"call",action:"import",id:transferId}]}};
}

test("destination rollback analyzer accepts complete physical observations independently of history",()=>{
  const r=report();r.initial.source.tick++;
  const result=analyze(r);
  assert.equal(result.verdict,"PASS");assert.equal(result.observation.importRequests,1);
});

test("completed history cannot hide missing physical copies after destination rollback",()=>{
  const r=report();for(const s of r.rollback.samples) s.destination=absent();
  const result=analyze(r);
  assert.equal(result.verdict,"STOP");
  assert.ok(result.violations.includes("no physical platform copy in either running world"));
  assert.equal(result.observation.finalHistoryStatus,"completed");
  assert.equal(result.observation.finalSourcePresent,false);assert.equal(result.observation.finalDestinationPresent,false);
  assert.equal(result.observation.finalDestinationUsable,false);
});

test("destination rollback summary distinguishes presence from every usability protection",()=>{
  for(const mutate of [s=>s.platformHidden=true,s=>s.surfaceHidden=true,s=>s.locked=true,
    s=>s.held=true,s=>s.canary.active=false,s=>s.canary.disabled=true]) {
    const r=report(),last=r.rollback.samples.at(-1).destination;
    mutate(last);last.usable=false;
    const result=analyze(r);
    assert.equal(result.verdict,"STOP");
    assert.equal(result.observation.finalDestinationPresent,true);
    assert.equal(result.observation.finalDestinationUsable,false);
    assert.ok(result.violations.includes("normal recovery did not leave one usable destination within the observation window"));
  }
  assert.equal(analyze(report()).observation.finalDestinationUsable,true);
});

test("destination rollback uses and validates the report's embedded observation bounds",async()=>{
  const bounds=r=>r.contract.cases.find(c=>c.id==="restore-old-destination");
  const longer=report();bounds(longer).observationMs=70000;
  assert.throws(()=>analyze(longer),/full recovery observation window/);
  const shorter=report();bounds(shorter).observationMs=60000;
  shorter.rollback.samples[1].offsetMs=60000;shorter.rollback.observedMs=60010;
  assert.equal(analyze(shorter).verdict,"PASS");
  for(const mutate of [r=>delete r.contract.cases,r=>r.contract.cases=[],
    r=>r.contract.cases.push({...bounds(r)}),r=>bounds(r).observationMs=0,
    r=>bounds(r).observationMs=NaN,r=>bounds(r).intervalMs=0,
    r=>bounds(r).maximumSamples=1,r=>bounds(r).maximumSamples=1.5]) {
    const r=report();mutate(r);
    assert.throws(()=>analyze(r),/rollback.*bounds|rollback.*contract/);
    await assert.rejects(destinationRollbackCase({},r,()=>{}),/rollback.*bounds|rollback.*contract/);
  }
  await assert.rejects(destinationRollbackCase({run,probe:()=>{throw Error("fixture setup reached");}},shorter,()=>{}),/fixture setup reached/);
});

test("oversized checkpoints stop at the size guard without retrying or reading the file",async()=>{
  const lab=new DockerLab(run,"unused");let stats=0,reads=0;
  lab.lua=()=>({result:{success:true}});
  const until=lab.until.bind(lab);lab.until=(read,label)=>until(read,label,.001);
  lab.docker=args=>{
    let output="";
    const modules={fs:{statSync:()=>{stats++;return {size:268435457};},
      readFileSync:()=>{reads++;throw Error("oversized file was read");}},jszip:{},crypto:{}};
    vm.runInNewContext(args.at(-2),{require:name=>modules[name],process:{argv:["node",args.at(-1)]},
      console:{log:value=>{output=String(value);}}});
    return output;
  };
  await assert.rejects(lab.checkpoint("manual-oversized",[2]),error=>{
    assert.match(error.message,/checkpoint exceeds 256 MiB/);
    assert.doesNotMatch(error.message,/timed out/);
    assert.equal(error.retryable,false);return true;
  });
  assert.equal(stats,1);assert.equal(reads,0);
});

test("checkpoint retries incomplete writes and still requires a verified digest",async()=>{
  const lab=new DockerLab(run,"unused");let attempts=0;
  lab.lua=()=>({result:{success:true}});
  lab.docker=()=>{
    if(++attempts===1)throw Error("ZIP still being written");
    return JSON.stringify({sha256:"a".repeat(64)});
  };
  const until=lab.until.bind(lab);lab.until=(read,label)=>until(read,label,2);
  assert.deepEqual(await lab.checkpoint("manual-pending",[2]),{2:"a".repeat(64)});
  assert.equal(attempts,2);
});

for(const guard of [
  {name:"destination usability summary",file:"oracle.mjs",find:"finalDestinationUsable:last.destination.usable===true",
    replace:"finalDestinationUsable:true",check:module=>{
      const r=report();for(const s of r.rollback.samples)s.destination=absent();
      assert.equal(module.analyze(r).observation.finalDestinationUsable,false);
    }},
  {name:"embedded observation window",file:"oracle.mjs",find:"previous>=bounds.observationMs",replace:"true",check:module=>{
    const r=report();r.contract.cases.find(c=>c.id==="restore-old-destination").observationMs=70000;
    assert.throws(()=>module.analyze(r),/full recovery observation window/);
  }},
  {name:"permanent checkpoint error",file:"docker-lab.mjs",find:"if(error.retryable===false) throw error;",replace:"",check:async module=>{
    const lab=new module.DockerLab(run,"unused"),fatal=Object.assign(new Error("checkpoint exceeds 256 MiB"),{retryable:false});
    await assert.rejects(lab.until(()=>{throw fatal;},"verified checkpoint",.001),error=>error===fatal);
  }}
]) test(`regression rejects removal of ${guard.name}`,async()=>{
  const url=new URL(guard.file,import.meta.url);
  await guard.check(await import(url.href));
  const mutant=await importMutation(url,guard);
  await assert.rejects(async()=>guard.check(mutant),{name:"AssertionError"});
});

test("late recovery cannot erase an earlier absence and one import cannot hide changed cargo",()=>{
  for(const mutate of [r=>r.rollback.samples[0].destination=absent(),
    r=>r.rollback.samples[0].source=copy(),
    r=>r.rollback.samples[1].destination.cargo.inventories["steel-chest@8.5,4.5:1"]["iron-plate/rare"]--,
    r=>r.rollback.samples[1].destination.cargo.lanes["transport-belt@-7.5,5.5:1"]["iron-plate/normal"]--,
    r=>r.rollback.samples[1].destination.cargo.fluids["storage-tank@-7.5,0.5"].amount--,
    r=>r.events[2].push(r.events[2][0])]) {
    const r=report();mutate(r);assert.equal(analyze(r).verdict,"STOP");
  }
});

test("retained live destination rollback remains a negative acceptance result",()=>{
  const r=JSON.parse(gunzipSync(readFileSync(new URL("evidence/destination-rollback-2.1.17.json.gz",import.meta.url))));
  const result=analyze(r);
  assert.equal(result.verdict,"STOP");
  assert.ok(result.violations.includes("no physical platform copy in either running world"));
  assert.equal(result.observation.finalHistoryStatus,"completed");
  assert.equal(result.observation.importRequests,1);
});

test("destination rollback requires valid control, generation, history, observation window and cleanup",()=>{
  for(const mutate of [r=>r.control.sample.destination.cargo.entities.pop(),
    r=>r.control.outcome={transferId:r.transferId,status:"cleanup_failed"},
    r=>r.control.load.marker.generation="before",r=>r.control.reconciliationReady=false,r=>r.rollback.load.host=1,
    r=>r.rollback.load.sha256="3".repeat(64),r=>r.checkpoints.before.marker.run="foreign",
    r=>r.initial.destination=copy(),r=>r.checkpoints.before.sha256=null,
    r=>r.rollback.samples[1].offsetMs=64000,r=>r.rollback.observedMs=1,
    r=>delete r.rollback.samples[0].destination,r=>r.rollback.samples[0].outcome={transferId:"another",status:"completed"},
    r=>r.rollback.samples[1].offsetMs=NaN,r=>r.events[2]=[],r=>r.cleanup.success=false]) {
    const r=report();mutate(r);assert.throws(()=>analyze(r));
  }
});

test("checkpoint selection saves only the requested instance and rejects invalid lists before RCON",async()=>{
  const lab=new DockerLab(run,"unused"),saved=[];
  lab.lua=host=>{saved.push(host);return {result:{success:true}};};
  lab.until=async read=>read();lab.checkpointHash=()=>"1".repeat(64);
  assert.deepEqual(await lab.checkpoint("manual-destination-before",[2]),{2:"1".repeat(64)});
  assert.deepEqual(saved,[2]);saved.length=0;
  assert.deepEqual(await lab.checkpoint("manual-default"),{1:"1".repeat(64),2:"1".repeat(64)});
  assert.deepEqual(saved,[1,2]);saved.length=0;
  for(const hosts of [[],[0],[1,1],[2,3]]) await assert.rejects(lab.checkpoint("manual-test",hosts),/invalid checkpoint hosts/);
  assert.deepEqual(saved,[]);
});

test("checkpoint loading verifies ownership, bytes and loaded generation, and only loads destination",async()=>{
  const checkpoint=report().checkpoints.before,calls=[];
  const lab={hosts:{2:{container:`${run}-host-2`}},
    assertOwned:(kind,name)=>calls.push([kind,name]),checkpointHash:()=>checkpoint.sha256,
    load:async(host,name)=>calls.push([host,name]),lua:()=>({result:{marker:checkpoint.marker}})};
  assert.deepEqual(await loadDestinationCheckpoint(lab,checkpoint),checkpoint);
  assert.deepEqual(calls,[["container",`${run}-host-2`],[2,checkpoint.name]]);calls.length=0;
  await assert.rejects(loadDestinationCheckpoint(lab,{...checkpoint,host:1}),/only destination/);
  assert.deepEqual(calls,[]);
  lab.checkpointHash=()=>"9".repeat(64);
  await assert.rejects(loadDestinationCheckpoint(lab,checkpoint),/changed before loading/);
  assert.ok(calls.every(c=>c[0]==="container"));calls.length=0;
  lab.assertOwned=()=>{throw Error("foreign resource");};
  await assert.rejects(loadDestinationCheckpoint(lab,checkpoint),/foreign resource/);assert.deepEqual(calls,[]);
  lab.assertOwned=()=>{};lab.checkpointHash=()=>checkpoint.sha256;
  lab.lua=()=>({result:{marker:{run,generation:"after"}}});
  await assert.rejects(loadDestinationCheckpoint(lab,checkpoint),/wrong checkpoint generation/);
});
