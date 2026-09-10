import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { ROOT, PLUGIN, sleep } from "./docker-lab.mjs";
import { expectedCargo } from "../../integration/transfer-cleanup/oracle.mjs";
import { performanceCargo } from "./oracle.mjs";

function summary(lab,id) {
  const raw=lab.ctl("surface-export","list-transfers","200");
  const rows=JSON.parse(raw.trim().split(/\r?\n/).at(-1));
  return rows.find(r=>r.transferId===id);
}
function start(lab,name) {
  const {result}=lab.lua(1,`local p;for _,v in pairs(game.forces.player.platforms) do if v.name=='${name}' then assert(not p);p=v end end
    local trigger=assert(package.loaded['__level__/modules/surface_export/core/transfer-trigger.lua'])
    local job,err=trigger.start(game.forces.player,assert(p).index,${lab.ids[2]});assert(job,err);return {success=true,job=job}`);
  return `${lab.ids[1]}:${result.job}`;
}
const sample=(lab,name)=>({source:lab.probe(1,"read",name).state,destination:lab.probe(2,"read",name).state});
async function terminal(lab,id,status="completed") {
  let last;
  try {return await lab.until(()=>{last=summary(lab,id);return last?.status===status&&last;},`transfer ${status}`,120);}
  catch(error) {
    if(!last||lab.cancelled||Date.now()>lab.deadline) throw error;
    return {...last,observationTimedOut:true};
  }
}

export async function recoveryCase(lab,report,save) {
  const name=report.name=`transfer-cleanup-${lab.run}-${report.case}`;
  report.before=lab.probe(1,"build",name).state;
  assert.deepEqual(report.before.cargo,expectedCargo,"physical fixture does not match the independent contract");
  const checkpoint=`manual-${report.case}`;
  if(["crash-source-before-save","restore-old-source"].includes(report.case)) {
    // Only owned instances. Do not allow the image to choose a save on host restart.
    lab.ctl("instance","config","set",lab.hosts[1].instance,"instance.auto_start","false");
    report.checkpoint=await lab.checkpoint(checkpoint);
  }
  const fault=report.case!=="restore-old-source";
  const host=report.case==="lost-destination-reply"?2:1;
  if(fault) lab.writeFault(host,{run:lab.run,enabled:true,name,action:host===1?"source":"destination"});
  report.transferId=start(lab,name);save();
  if(fault) {
    report.held=await lab.until(()=>lab.events(host).find(e=>e.kind==="response-held"&&e.name===name),"real successful response held",120);
    report.samples=[sample(lab,name)];
    assert.equal(report.samples[0].source.present,false,"source deletion did not actually occur");
    if(host===1) assert.equal(report.samples[0].destination.held,true,"destination was not held before reply loss");
    else assert.equal(report.samples[0].destination.usable,true,"destination was not actually released");
    save();
    lab.writeFault(host,{run:lab.run,enabled:false});
    if(report.case==="crash-source-before-save") {
      report.interruption={kind:"SIGKILL source host",checkpoint};save();
      await lab.load(1,checkpoint,{crash:true});
      report.samples.push(sample(lab,name));save();
      report.outcome=await terminal(lab,report.transferId);
    } else {
      report.interruption={kind:"controller SIGKILL after held successful reply"};save();
      lab.mutateContainer("kill",lab.controller,["--signal","KILL"]);
      if(report.case==="aged-recovery-intent") {
        report.agedIntent=lab.ageRecoveryIntent(report.transferId);save();
      }
      lab.mutateContainer("start",lab.controller);
      await lab.ready();
      report.outcome=await terminal(lab,report.transferId);
    }
  } else {
    report.outcome=await terminal(lab,report.transferId);
    report.samples=[sample(lab,name)];
    assert.equal(report.samples[0].source.present,false);assert.equal(report.samples[0].destination.usable,true);
    report.interruption={kind:"restore earlier source save only",checkpoint};save();
    await lab.load(1,checkpoint);
  }
  report.samples.push(sample(lab,name));await sleep(500);report.samples.push(sample(lab,name));
  report.events={1:lab.events(1),2:lab.events(2)};save();
}

function percentile(values,fraction) {
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.max(0,Math.ceil(sorted.length*fraction)-1)];
}
export function performanceSummary(measurements) {
  const groups={};
  for(const m of measurements) for(const r of m.records) {
    const key=`${m.extraEntities}/${m.mode}/host-${r.host}/${r.boundary}`;
    (groups[key]??=[]).push(r.ms);
  }
  return Object.fromEntries(Object.entries(groups).map(([key,v])=>[key,{samples:v.length,p50Ms:percentile(v,.5),p95Ms:percentile(v,.95),maxMs:Math.max(...v)}]));
}
export async function performanceCase(lab,report,save) {
  const code=readFileSync(join(ROOT,"tests/manual/transfer-reliability/performance.lua"),"utf8");
  const {parseProfiler}=createRequire(import.meta.url)(join(PLUGIN,"dist/node/lib/timing.js"));
  report.measurements=[];
  const profile=(host,action,name,mode,extra=0)=>lab.lua(host,`return (function() ${code} end)()('${action}','${name}','${mode}',${extra})`);
  // Rotate mode order across repeats to expose (not eliminate) startup/cache bias.
  for(let repeat=0;repeat<3;repeat++) for(const extra of [0,512]) for(let offset=0;offset<3;offset++) {
    const mode=["off","normal","debug"][(repeat+offset)%3];
    const name=`transfer-cleanup-${lab.run}-perf-${repeat}-${extra}-${mode}`;
    const m={repeat,extraEntities:extra,mode,records:[]};report.measurements.push(m);
    lab.probe(1,"build",name); profile(1,"grow",name,mode,extra);
    m.before=lab.probe(1,"read",name).state;
    const expected=performanceCargo(extra);
    assert.deepEqual(m.before.cargo,expected,"performance construction contract");
    const armed=[];
    try {
      for(const host of [1,2]) {profile(host,"arm",name,mode);armed.push(host);}
      m.transferId=start(lab,name); m.outcome=await terminal(lab,m.transferId);
      m.after=sample(lab,name);
      const sourceJob=m.transferId.slice(m.transferId.indexOf(":")+1);
      m.codec=lab.lua(1,`local e=assert(storage.platform_exports[${JSON.stringify(sourceJob)}]);return {success=true,version=e.section_codec or 0,sections=e.section_count or 0}`).result;
      m.parity=m.after.source.present===false&&m.after.destination.usable===true
        &&isDeepStrictEqual(m.after.destination.cargo,expected)&&m.outcome.status==="completed";
    } finally {
      for(const host of armed) {
        const {result,raw}=profile(host,"disarm",name,mode);m.truncated ||= result.truncated;
        for(const line of raw.split(/\r?\n/)) {
          const index=line.indexOf("[SE_MANUAL_PROFILE]");if(index<0) continue;
          const [meta,reading]=line.slice(index+"[SE_MANUAL_PROFILE]".length).split("\t");
          const ms=parseProfiler(reading);assert.ok(ms!==null,"unavailable profiler reading");
          m.records.push({host,...JSON.parse(meta),ms,raw:reading});
        }
        assert.equal(result.count,m.records.filter(r=>r.host===host).length,"missing profiler output");
      }
    }
    if(!m.parity) {save();return;}
    for(const host of [1,2]) lab.probe(host,"cleanup",name);
    save();console.log(`performance: ${extra+6} entities / ${mode} / repeat ${repeat+1}: parity passed`);
  }
  report.statistics=performanceSummary(report.measurements);
  report.limitations=["Off disables only operation-timing.lua; legacy diagnostics remain.",
    "Outer profiler stays enabled in all modes; results include its overhead and host scheduling noise.",
    "Three repeats of fixed fixtures are not a supported-size guarantee or a causal before/after phase-yield benchmark.",
    "Scheduler and setup intervals have separate boundaries; nested intervals are never summed."];
}
