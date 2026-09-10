import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {withWorkflowLock} from '../../../tools/shared/workflow-lock.mjs';
import {DockerLab,ROOT,hash,sleep} from './docker-lab.mjs';
import {performanceCargo} from './oracle.mjs';

const mode=process.argv[2];
const sectionedCodec=!process.argv.includes('--legacy');
const fault=process.argv.find(arg=>arg.startsWith('--lost-reply='))?.split('=')[1];
assert.ok(fault===undefined||['source','destination'].includes(fault),'Use --lost-reply=source or --lost-reply=destination');
assert.ok(['--run','--cleanup-proof','--analyze'].includes(mode),'Use --run, --cleanup-proof or --analyze <result.json>');
const terminal=new Set(['completed','failed','error','cleanup_failed']);
function analyze(report) {
  assert.equal(report.cleanup.success,true,'resources remain');
  assert.ok(!report.error,report.error);
  if(typeof report.sectionedCodec==='boolean')for(const host of [1,2]) {
    assert.equal(report.environment.preflight[host].config.sectioned_codec,report.sectionedCodec,'runtime codec differs from requested configuration');
  }
  assert.equal(report.platforms.length,report.fault?2:3);
  assert.equal(report.replay.acceptedId,report.platforms[0].acceptedId,'duplicate admission changed identity');
  assert.ok(report.samples.some(s=>s.active===2),'no overlapping transfers observed');
  assert.ok(report.samples.every(s=>s.active<=2),'configured overlap limit exceeded');
  if(report.fault) {
    assert.equal(report.held?.success,true,'no real successful reply was held');
    assert.equal(report.interruption,'controller SIGKILL','recovery was not exercised');
    assert.equal(report.atFault.source.present,false,'source deletion did not occur');
    assert.equal(report.atFault.destination[report.fault==='source'?'held':'usable'],true,'unexpected destination protection state');
    assert.deepEqual(report.atFault.destination.cargo,report.platforms[0].before.cargo,'cargo changed at the lost-reply boundary');
    const retries=Object.values(report.events).flat().filter(e=>e.kind==='call'&&e.action===report.fault&&e.id===report.held.id
      &&(report.fault!=='destination'||e.gate==='go_live'));
    assert.ok(retries.length>=2,'no real recovery retry');
  }
  for(const row of report.platforms) {
    assert.equal(row.outcome?.status,'completed',`transfer ${row.name} did not complete`);
    assert.equal(row.after.source.present,false);
    assert.equal(row.after.destination.usable,true);
    assert.deepEqual(row.before.cargo,performanceCargo(512));
    assert.deepEqual(row.after.destination.cargo,row.before.cargo,'physical cargo changed');
    const calls=Object.values(report.events).flat().filter(e=>e.kind==='call'&&e.action==='import'&&e.id.includes(row.name));
    assert.equal(calls.length,1,'canonical transfer imported more than once');
  }
  return {verdict:'PASS',scope:report.fault
    ? `Two opposing transfers, capacity 2, duplicate admission, lost ${report.fault} reply and controller SIGKILL; real retry and exact physical cargo.`
    : 'Three opposing controller requests, capacity 2, one duplicate admission; sampled overlap and exact physical cargo. No crash injected.'};
}
if(mode==='--analyze') {
  const input=readFileSync(process.argv[3]);
  console.log(JSON.stringify(analyze(JSON.parse(process.argv[3].endsWith('.gz')?gunzipSync(input):input)),null,2));
}
else await withWorkflowLock(async()=>{
  const run=`se-manual-${Date.now().toString(36)}-${randomUUID().slice(0,8)}`;
  const directory=join(ROOT,'ci-artifacts',run);mkdirSync(directory,{recursive:true});
  const lab=new DockerLab(run,directory,{sectionedCodec});
  const report={run,kind:'pipeline-overlap',fault,sectionedCodec,platforms:[],samples:[],hashes:{},contract:{capacity:2,luaStepsPerTick:1,
    maxPlatforms:3,extraChestsPerPlatform:512,maxSeconds:600,engine:'2.1.17',
    controls:'Disposable instances only; fixed independent cargo oracle; normal production controller admission; no edited verdicts or unlock assists.'}};
  for(const name of ['pipeline-transfer.mjs','docker-lab.mjs','performance.lua','oracle.mjs','fault-hook.cjs'])report.hashes[name]=hash(new URL(name,import.meta.url));
  const file=join(directory,'result.json'),save=()=>writeFileSync(file,JSON.stringify(report,null,2)+'\n');
  const interrupt=()=>{lab.cancelled=true;};process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
  save();
  try {
    console.log(`Starting bounded transfer overlap ${run}`);
    report.environment=await lab.setup();lab.deadline=Date.now()+600000;
    lab.ctl('controller','config','set','surface_export.max_inflight_transfers_per_instance','2');
    for(const host of [1,2]) lab.lua(host,'remote.call("surface_export","configure",{max_concurrent_jobs=1});return {success=true}');
    const grow=readFileSync(new URL('./performance.lua',import.meta.url),'utf8');
    for(let n=0;n<(fault?2:3);n++) {
      const source=n===1?2:1,target=source===1?2:1,name=`transfer-cleanup-${run}-pipeline-${n}`;
      lab.probe(source,'build',name);
      lab.lua(source,`return (function() ${grow} end)()('grow','${name}','normal',512)`);
      const before=lab.probe(source,'read',name).state;
      assert.deepEqual(before.cargo,performanceCargo(512));
      report.platforms.push({name,source,target,before});save();
    }
    if(mode==='--cleanup-proof')throw new Error('Intentional failure after creating three owned fixtures');
    if(fault)lab.writeFault(fault==='source'?1:2,{run,enabled:true,name:report.platforms[0].name,action:fault});
    const submit=row=>{
      const raw=lab.ctl('surface-export','start-transfer',String(lab.ids[row.source]),String(row.before.index),String(lab.ids[row.target]));
      const id=raw.match(/(request:[a-f0-9-]+)/)?.[1];assert.ok(id,`missing admission identity: ${raw}`);return id;
    };
    for(const [index,row] of report.platforms.entries()) {
      row.acceptedId=submit(row);
      if(index===0)report.replay={acceptedId:submit(row)};
      save();
    }
    const ids=new Set(report.platforms.map(p=>p.acceptedId));
    for(let attempt=0;attempt<120;attempt++) {
      const all=JSON.parse(lab.ctl('surface-export','list-transfers','200').trim().split(/\r?\n/).at(-1));
      const rows=all.filter(r=>ids.has(r.transferId)||ids.has(r.queuedRequestId)||String(r.platformName).startsWith(`transfer-cleanup-${run}-pipeline-`));
      const active=rows.filter(r=>r.status!=='queued'&&!terminal.has(r.status)).length;
      report.samples.push({utc:new Date().toISOString(),active,rows});save();
      if(fault&&!report.interruption) {
        report.held=lab.events(fault==='source'?1:2).find(e=>e.kind==='response-held'&&e.name===report.platforms[0].name);
        if(report.held) {
          const name=report.platforms[0].name;
          report.atFault={source:lab.probe(1,'read',name).state,destination:lab.probe(2,'read',name).state};save();
          lab.writeFault(fault==='source'?1:2,{run,enabled:false});
          report.interruption='controller SIGKILL';save();
          lab.mutateContainer('kill',lab.controller,['--signal','KILL']);
          lab.mutateContainer('start',lab.controller);await lab.ready();
          continue;
        }
      }
      // Restart marks admission records interrupted before the normal 30-second
      // recovery loop retries them. Observe completion within the existing bound;
      // an intermediate error is not the final result of this recovery experiment.
      if(rows.filter(r=>fault?r.status==='completed':terminal.has(r.status)).length===report.platforms.length) {
        for(const row of report.platforms)row.outcome=rows.find(r=>r.platformName===row.name);
        break;
      }
      await sleep(500);
    }
    for(const row of report.platforms) {
      row.after={source:lab.probe(row.source,'read',row.name).state,destination:lab.probe(row.target,'read',row.name).state};save();
    }
    report.events={1:lab.events(1),2:lab.events(2)};
  } catch(error) {report.error=error.stack;}
  finally {
    report.cleanup=await lab.cleanup();
    process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);
    if(mode==='--cleanup-proof')report.cleanupProofPassed=!!report.error?.includes('Intentional failure')&&report.cleanup.success;
    if(!report.error)try {Object.assign(report,analyze(report));}catch(error){report.error=error.stack;report.verdict='STOP';}
    else report.verdict='HARNESS_ERROR';
    save();console.log(JSON.stringify({artifact:file,verdict:report.verdict,error:report.error,cleanup:report.cleanup.success,cleanupProofPassed:report.cleanupProofPassed},null,2));
    process.exitCode=report.verdict==='PASS'||report.cleanupProofPassed?0:1;
  }
});
