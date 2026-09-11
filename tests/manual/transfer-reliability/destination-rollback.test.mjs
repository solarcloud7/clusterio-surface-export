import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { analyze, performanceCargo } from "./oracle.mjs";
import { DockerLab } from "./docker-lab.mjs";
import { loadDestinationCheckpoint } from "./destination-rollback.mjs";

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
  return {schemaVersion:1,contract:{schemaVersion:4},case:"restore-old-destination",run,name,transferId,
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
