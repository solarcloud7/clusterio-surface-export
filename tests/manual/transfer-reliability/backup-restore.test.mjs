import test from "node:test";
import assert from "node:assert/strict";
import { analyze, performanceCargo } from "./oracle.mjs";
import { VOLUME_SUFFIXES, validateStorageRequest } from "./backup-storage.mjs";
import { volumeAction } from "./backup-restore.mjs";

const run="se-manual-backup-offline";
const copy=()=>({present:true,usable:true,tick:10,platformHidden:false,surfaceHidden:false,
  locked:false,held:false,canary:{active:true,disabled:false},cargo:performanceCargo(0)});
const sample=()=>({source:{present:false,tick:10},destination:copy()});
function report() {
  const name=`transfer-cleanup-${run}-pending`,id=`1:${name}`,historyId=`1:transfer-cleanup-${run}-history`;
  const first=sample();first.destination.held=true;first.destination.usable=false;
  const authority={"surface_export_pending_transfers.json":{pending:1},"surface_export_transaction_audit.jsonl":{completedRows:2}};
  return {schemaVersion:1,case:"coordinated-restore",cleanup:{success:true},name,transferId:id,before:copy(),
    held:{success:true,id},samples:[first,sample()],outcome:{transferId:id,status:"completed"},
    history:{before:copy(),transferId:historyId,samples:[sample(),sample()],restoredOutcome:{transferId:historyId,status:"completed"}},
    checkpoint:{1:"a".repeat(64),2:"b".repeat(64)},authority,restoredAuthority:structuredClone(authority),
    backup:{elapsedMs:1,restoreElapsedMs:2,
      archives:VOLUME_SUFFIXES.map(suffix=>({suffix,sha256:"c".repeat(64),bytes:10240,compared:true})),
      erased:VOLUME_SUFFIXES.map(suffix=>({suffix,empty:true,erasedEntries:2})),
      restored:VOLUME_SUFFIXES.map(suffix=>({suffix,sha256:"c".repeat(64),compared:true}))},
    events:{1:[{kind:"call",action:"source",id},{kind:"call",action:"source",id}],
      2:[id,historyId].map(id=>({kind:"call",action:"import",id}))}};
}
test("restore oracle accepts complete independent evidence",()=>assert.equal(analyze(report()).verdict,"PASS"));
test("restore oracle refuses missing volumes, erasure, comparison and backup generation mismatch",()=>{
  for(const mutate of [r=>r.backup.archives.pop(),r=>r.backup.restored.push(r.backup.restored[0]),
    r=>r.backup.erased[0].empty=false,r=>r.backup.restored[0].compared=false,
    r=>r.backup.restored[0].sha256="d".repeat(64),r=>r.checkpoint[1]=undefined]) {
    const r=report();mutate(r);assert.throws(()=>analyze(r));
  }
});
test("restore oracle detects cargo loss, duplicate usable copies, repeated imports and lost history",()=>{
  for(const mutate of [r=>r.samples.at(-1).destination.cargo.entities.pop(),
    r=>r.samples.at(-1).source=copy(),r=>r.events[2].push(r.events[2][0]),
    r=>r.history.restoredOutcome.status="started"]) {
    const r=report();mutate(r);assert.equal(analyze(r).verdict,"STOP");
  }
});
test("restore oracle requires uncertain authority and an actual normal retry",()=>{
  for(const mutate of [r=>r.authority["surface_export_pending_transfers.json"].pending=0,
    r=>r.restoredAuthority["surface_export_transaction_audit.jsonl"].completedRows=0,
    r=>r.events[1].pop(),r=>r.samples[0].destination.held=false]) {
    const r=report();mutate(r);assert.throws(()=>analyze(r));
  }
});
test("storage helper rejects unscoped destructive actions and missing hashes",()=>{
  assert.doesNotThrow(()=>validateStorageRequest("backup","tokens",run));
  for(const args of [["erase","tokens",run],["erase","../tokens",run,"a".repeat(64)],
    ["erase","tokens","surface-export","a".repeat(64)],["delete","tokens",run]])
    assert.throws(()=>validateStorageRequest(...args));
});
test("volume mutation refuses running services and foreign ownership before docker run",()=>{
  const calls=[];
  const lab={run,controller:`${run}-controller`,hosts:{1:{container:`${run}-host-1`},2:{container:`${run}-host-2`}},
    assertOwned:()=>{},docker:args=>{calls.push(args);return JSON.stringify([{State:{Running:true}}]);}};
  assert.throws(()=>volumeAction(lab,"erase","tokens","a".repeat(64)),/every service stopped/);
  assert.ok(calls.every(args=>args[0]==="container"&&args[1]==="inspect"));calls.length=0;
  lab.assertOwned=()=>{throw Error("foreign owner");};
  assert.throws(()=>volumeAction(lab,"erase","tokens","a".repeat(64)),/foreign owner/);
  assert.equal(calls.length,0);
});
