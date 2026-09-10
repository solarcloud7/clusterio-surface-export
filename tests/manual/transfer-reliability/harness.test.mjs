import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, statSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { DockerLab, validRun } from "./docker-lab.mjs";
import { evaluateCopies, analyze, performanceCargo } from "./oracle.mjs";
import { ageIntent } from "./age-intent.mjs";

const run="se-manual-offline-12345678";
const copy=()=>({present:true,usable:true,tick:10,platformHidden:false,surfaceHidden:false,
  locked:false,held:false,canary:{active:true,disabled:false},cargo:performanceCargo(0)});
const absent=()=>({present:false,tick:10});
test("age injection only changes the exact owned intent timestamp",t=>{
  const directory=mkdtempSync(join(tmpdir(),"se-age-intent-"));
  const file=join(directory,"surface_export_pending_transfers.json"),id=`1:${run}:job`;
  t.after(()=>{unlinkSync(file);rmdirSync(directory);});
  const entries=[{transferId:id,startedAt:100,cargo:"untouched",source:1},{transferId:"foreign",startedAt:90}];
  writeFileSync(file,JSON.stringify(entries));
  assert.throws(()=>ageIntent(directory,"foreign",run,1000),/foreign transfer/);
  const result=ageIntent(directory,id,run,1000);
  assert.equal(result.after,1000-86400000);
  entries[0].startedAt=result.after;
  assert.deepEqual(JSON.parse(readFileSync(file)),entries);
});
test("independent physical oracle detects duplication and changed cargo",()=>{
  const before=copy(), sample={source:absent(),destination:copy()};
  assert.equal(evaluateCopies(before,[sample,sample]).verdict,"PASS");
  assert.ok(evaluateCopies(before,[sample,{source:copy(),destination:copy()}]).violations.includes("two usable copies"));
  sample.destination.cargo.entities.pop();
  assert.ok(evaluateCopies(before,[sample,sample]).violations.includes("physical cargo changed"));
  assert.throws(()=>evaluateCopies(before,[{source:absent()},sample]),/missing observation/);
  assert.ok(evaluateCopies(before,[{source:absent(),destination:absent()},sample]).violations.includes("no recoverable copy"));
});
test("cleanup checks both exact owner label and resource name before a mutation",()=>{
  assert.equal(validRun("surface-export"),false);
  const lab=new DockerLab(run,"unused"); const calls=[];
  lab.docker=args=>{calls.push(args);return JSON.stringify([{Config:{Labels:{"surface-export.manual-run":"another-run"}}}]);};
  assert.throws(()=>lab.mutateContainer("kill","surface-export-host-1"),/foreign resource name/);
  assert.equal(calls.length,0);
  assert.throws(()=>lab.mutateContainer("kill",`${run}-host-1`),/foreign Docker resource/);
  assert.equal(calls.length,1);assert.equal(calls[0][1],"inspect");
});
test("verbose log overflow retains bounded marked output instead of falsifying cleanup failure",t=>{
  const dir=mkdtempSync(join(tmpdir(),"se-log-bound-")),name=`${run}-host-1`;
  t.after(()=>{unlinkSync(join(dir,`${name}.log`));rmdirSync(dir);});
  const lab=new DockerLab(run,dir);
  const result=lab.captureLogs(name,()=>({error:{code:"ENOBUFS"},stdout:Buffer.alloc(1048580)}));
  assert.equal(result.truncated,true);assert.equal(result.bytes,1048576);
  assert.equal(statSync(join(dir,`${name}.log`)).size,1048576);
});
test("successful Docker log capture retains fatal errors on stderr and rejects command failure",t=>{
  const dir=mkdtempSync(join(tmpdir(),"se-log-streams-")),name=`${run}-controller`;
  t.after(()=>{unlinkSync(join(dir,`${name}.log`));rmdirSync(dir);});
  const lab=new DockerLab(run,dir);
  const result=lab.captureLogs(name,()=>({status:0,stdout:Buffer.from("Started controller\n"),stderr:Buffer.from("LockFileExistsError\n")}));
  assert.equal(result.truncated,false);
  const text=readFileSync(join(dir,`${name}.log`),"utf8");
  assert.match(text,/Started controller/);assert.match(text,/LockFileExistsError/);assert.match(text,/separate stream/);
  assert.throws(()=>lab.captureLogs(name,()=>({status:1,stderr:Buffer.from("No such container")})),/No such container/);
});
test("recovery oracle requires a real fault, exactly one import, and a retry",()=>{
  const id=`1:transfer-cleanup-${run}-a`, sample={source:absent(),destination:copy()};
  const report={schemaVersion:1,case:"lost-source-reply",cleanup:{success:true},name:`transfer-cleanup-${run}-a`,
    transferId:id,before:copy(),held:{success:true,id},samples:[sample,sample],outcome:{status:"completed"},
    events:{1:[{kind:"call",action:"source",id},{kind:"call",action:"source",id}],2:[{kind:"call",action:"import",id}]}};
  assert.equal(analyze(report).verdict,"PASS");
  report.events[2].push(report.events[2][0]);assert.throws(()=>analyze(report),/exactly one/);report.events[2].pop();
  report.events[1].pop();assert.throws(()=>analyze(report),/retry/);report.events[1].push(report.events[1][0]);
  report.held.success=false;assert.throws(()=>analyze(report),/not accepted/);
});
test("source crash contract distinguishes historical safety from recovery completion",()=>{
  const id=`1:transfer-cleanup-${run}-a`, heldCopy={...copy(),usable:false,held:true};
  const sample={source:copy(),destination:heldCopy};
  const report={schemaVersion:1,contract:{schemaVersion:1},case:"crash-source-before-save",
    cleanup:{success:true},name:`transfer-cleanup-${run}-a`,transferId:id,before:copy(),
    held:{success:true,id},samples:[sample,sample],outcome:{status:"cleanup_failed"},
    events:{1:[{kind:"call",action:"source",id}],2:[{kind:"call",action:"import",id}]}};
  assert.equal(analyze(report).verdict,"PASS","historical result only asserted safety");
  report.contract.schemaVersion=2;
  assert.equal(analyze(report).verdict,"STOP","retained protection is not completed recovery");
  report.outcome.status="completed";
  report.samples.push({source:absent(),destination:copy()});
  assert.throws(()=>analyze(report),/retry/);
  report.events[1].push(report.events[1][0]);
  assert.equal(analyze(report).verdict,"PASS");
});
for (const runtimePath of ["/surface_export/dist/node/instance.js", "/consumer/node_modules/@solarcloud7/plugin-surface-export/dist/node/instance.js"])
test(`fault hook holds only an accepted scoped reply once (${runtimePath})`,async()=>{
  let calls=0, rule={run,enabled:true,name:`transfer-cleanup-${run}-a`,action:"source"}; const events=[];
  class InstancePlugin {
    async handleDeleteSourcePlatformMeasured(req){calls++;return {success:req.accepted};}
    async handleDestinationTransferGate(){return {success:true};}
    async handleImportPlatformRequestMeasured(){return {success:true};}
  }
  const module={_load:()=>({InstancePlugin}),_resolveFilename:()=>runtimePath};
  const fs={existsSync:()=>true,readFileSync:()=>JSON.stringify(rule),appendFileSync:(_,s)=>events.push(JSON.parse(s))};
  vm.runInNewContext(readFileSync(new URL("fault-hook.cjs",import.meta.url),"utf8"),{
    require:name=>name==="node:fs"?fs:module,process:{env:{SE_MANUAL_RUN:run},pid:1},Symbol,Date,Set,Promise,
  });
  module._load("fixture");const instance=new InstancePlugin();
  assert.deepEqual(await instance.handleDeleteSourcePlatformMeasured({exportId:"foreign",accepted:true}),{success:true});
  const req={exportId:`1:${rule.name}`,accepted:false};
  assert.equal((await instance.handleDeleteSourcePlatformMeasured(req)).success,false);
  req.accepted=true;let resolved=false;instance.handleDeleteSourcePlatformMeasured(req).then(()=>{resolved=true;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(resolved,false);assert.equal(calls,3);assert.equal(events.filter(e=>e.kind==="response-held").length,1);
  assert.equal((await instance.handleDeleteSourcePlatformMeasured(req)).success,true);
});
test("performance comparison rejects duplicate samples, invented zero readings, and changed physical cargo",()=>{
  const measurements=[];
  for(const repeat of [0,1,2]) for(const extraEntities of [0,512]) for(const mode of ["off","normal","debug"]) {
    const cargo=performanceCargo(extraEntities);
    measurements.push({repeat,extraEntities,mode,before:{...copy(),cargo},after:{source:absent(),destination:{...copy(),cargo}},
      outcome:{status:"completed"},truncated:false,records:[1,2].flatMap(host=>["scheduler",host===1?"export_setup":"import_setup"]
        .map(boundary=>({host,boundary,ms:.75,raw:"0.750 ms",startTick:5,endTick:5,success:true})))});
  }
  const report={schemaVersion:1,case:"performance",cleanup:{success:true},measurements};
  assert.equal(analyze(report).verdict,"PASS");
  const saved=measurements[1];measurements[1]=measurements[0];assert.throws(()=>analyze(report),/duplicate/);measurements[1]=saved;
  measurements[0].records[0].ms=NaN;assert.throws(()=>analyze(report),/profiler/);measurements[0].records[0].ms=.75;
  measurements[0].after.destination.cargo=performanceCargo(512);assert.equal(analyze(report).verdict,"STOP");
});
