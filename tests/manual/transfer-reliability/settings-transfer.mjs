import { runLab } from './lifecycle.mjs';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {withWorkflowLock} from '../../../tools/shared/workflow-lock.mjs';
import {DockerLab,ROOT,hash} from './docker-lab.mjs';
import {compareSettings,canonicalSettings,luaSequence} from './settings-oracle.mjs';

const mode=process.argv[2];
const sectionedCodec=process.argv.includes('--sectioned');
assert.ok(['--run','--cleanup-proof','--analyze'].includes(mode),'Use --run, --cleanup-proof or --analyze <report>');
function analyze(report) {
  assert.equal(report.cleanup?.success,true,'Docker cleanup failed');
  assert.ok(!report.error,report.error);
  assert.ok(report.platforms?.length>0,'no platforms observed');
  return report.platforms.map(row=>{
    assert.equal(compareSettings(row.reference,row.before).verdict,'PASS','reference diverged before transfer');
    if(!row.transferId)return {name:row.name,verdict:'BLOCKED',reason:'prior platform stopped the run'};
    if(row.outcome?.status!=='completed'||!row.after||row.sourcePresent) return {name:row.name,verdict:'STOP',outcome:row.outcome};
    return {name:row.name,...compareSettings(row.before,row.after)};
  });
}
if(mode==='--analyze') {
  const input=readFileSync(process.argv[3]);
  const results=analyze(JSON.parse(process.argv[3].endsWith('.gz')?gunzipSync(input):input));
  console.log(JSON.stringify(results.map(({uncovered,...result})=>({...result,
    uncoveredCounts:uncovered&&{before:uncovered.before.length,after:uncovered.after.length}})),null,2));
  process.exitCode=results.every(r=>r.verdict==='PASS')?0:2;
} else await withWorkflowLock(async()=>{
  const run=`se-manual-${Date.now().toString(36)}-${randomUUID().slice(0,8)}`;
  const directory=join(ROOT,'ci-artifacts',run);mkdirSync(directory,{recursive:true});
  const report={run,kind:'golden-settings',sectionedCodec,platforms:[],hashes:{},contract:{engine:'2.1.17',maxPlatforms:12,
    maxEntitiesPerPlatform:12000,maxSeconds:1200,scope:'Native blueprint-visible configuration. Dynamic runtime state and physical cargo are not certified by this reader.',
    invariant:'Every blueprint-visible property and resolved wire endpoint survives the production transfer. Unblueprintable entities are explicitly uncovered.',
    controls:'Identical pinned golden save on two disposable instances; immutable direct reference read; renamed destination originals; no production exporter used by the oracle.'}};
  for(const file of ['settings-transfer.mjs','settings-observer.lua','settings-oracle.mjs','docker-lab.mjs'])report.hashes[file]=hash(new URL(file,import.meta.url));
  const file=join(directory,'result.json'),save=()=>writeFileSync(file,JSON.stringify(report,null,2)+'\n');
  const lab=new DockerLab(run,directory,{sameSourceSave:true,sectionedCodec});
  const code=readFileSync(new URL('./settings-observer.lua',import.meta.url),'utf8');
  const capture=(host,index,fail=false)=>lab.lua(host,`return (function() ${code} end)()(${index},${fail})`).result;
  save();
  process.exitCode=await runLab({lab,report,save,work:async()=>{
    console.log(`Starting golden settings comparison ${run}`);
    report.environment=await lab.setup();lab.deadline=Date.now()+1200000;save();
    const list=host=>luaSequence(lab.lua(host,"local p={};for _,v in pairs(game.forces.player.platforms) do p[#p+1]={name=v.name,index=v.index} end;return {success=true,platforms=p}").result.platforms);
    const sources=list(1),destinations=list(2);
    assert.ok(Array.isArray(sources)&&sources.length>0&&sources.length<=12,'fixture platform bound');
    assert.equal(destinations.length,sources.length);
    const cleanupProbe=capture(1,sources[0].index,true);
    assert.match(cleanupProbe.captureError,/intentional/);assert.equal(cleanupProbe.inventoryDestroyed,true);
    report.observerCleanupProof=cleanupProbe;save();
    if(mode==='--cleanup-proof')throw new Error('Intentional failure after observer cleanup proof');
    // Capture both immutable references before any transfers, avoiding destination name collisions.
    for(const source of sources) {
      const matching=destinations.filter(p=>p.name===source.name);assert.equal(matching.length,1,'ambiguous reference platform');
      const row={name:source.name,index:source.index,reference:capture(2,matching[0].index),before:capture(1,source.index)};
      canonicalSettings(row.reference);canonicalSettings(row.before);
      row.baseline=compareSettings(row.reference,row.before);report.platforms.push(row);save();
      assert.equal(row.baseline.verdict,'PASS',`reference settings differ: ${row.name}`);
      lab.lua(2,`game.forces.player.platforms[${matching[0].index}].name='reference-${matching[0].index}';return {success=true}`);
    }
    for(const row of report.platforms) {
      const started=lab.lua(1,`local trigger=assert(package.loaded['__level__/modules/surface_export/core/transfer-trigger.lua']);local id,err=trigger.start(game.forces.player,${row.index},${lab.ids[2]});assert(id,err);return {success=true,id=id}`).result;
      row.transferId=`${lab.ids[1]}:${started.id}`;save();
      row.outcome=await lab.until(()=>{
        const rows=JSON.parse(lab.ctl('surface-export','list-transfers','200').trim().split(/\r?\n/).at(-1));
        return rows.find(r=>r.transferId===row.transferId&&['completed','failed','error','cleanup_failed'].includes(r.status));
      },'terminal transfer',180);
      row.sourcePresent=list(1).some(p=>p.index===row.index);
      const arrivals=list(2).filter(p=>p.name===row.name);
      if(arrivals.length===1)row.after=capture(2,arrivals[0].index);
      row.comparison=row.after?compareSettings(row.before,row.after):{verdict:'STOP',reason:'no unique destination'};
      save();console.log(`${row.name}: ${row.outcome.status}, settings ${row.comparison.verdict}`);
      if(row.outcome.status!=='completed'||row.comparison.verdict!=='PASS')break;
    }
  },expectedFailure:mode==='--cleanup-proof'?/Intentional failure/:undefined,analyze:()=>{
    if(report.error)return {};report.results=analyze(report);return {verdict:report.results.every(r=>r.verdict==='PASS')?'PASS':'STOP'};
  }});
  console.log(JSON.stringify({artifact:file,verdict:report.verdict,error:report.error,cleanup:report.cleanup.success,cleanupProofPassed:report.cleanupProofPassed},null,2));
});
