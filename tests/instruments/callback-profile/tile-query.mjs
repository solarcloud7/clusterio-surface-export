import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {isDeepStrictEqual} from 'node:util';
import {withWorkflowLock} from '../../../tools/shared/workflow-lock.mjs';
import {docker,HOSTS,preflightState,assertLeaseClean,lua} from '../../lab-gallery/batch-lifecycle.mjs';
const {parseProfiler}=createRequire(import.meta.url)('../../../docker/seed-data/external_plugins/surface_export/dist/node/lib/timing.js');
const code=readFileSync(new URL('./tile-query.lua',import.meta.url),'utf8');
const normalize=values=>Array.isArray(values)?values:Object.values(values??{});
const ordered=values=>normalize(values).map(t=>[t.x,t.y,t.name]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]||a[2].localeCompare(b[2]));
class ParityFailure extends Error {}
function analyze(report) {
 assert.equal(report.mutated,false); assert.ok(report.samples.length>0);
 for(const r of report.samples) {
  assert.equal(r.success,true); assert.equal(r.engine,'2.1.17');
  if(!isDeepStrictEqual(ordered(r.candidate),ordered(r.legacy))) throw new ParityFailure('tile names or coordinates differ');
  assert.ok(normalize(r.candidate).every(t=>!['out-of-map','empty-space'].includes(t.name)));
  for(const kind of ['legacy','candidate']) assert.equal(parseProfiler(r.raw[kind]),r.ms[kind]);
 }
 return report.samples.map(({platform,candidateFirst,generated,candidateQueried,ms})=>({platform,candidateFirst,generated,retained:candidateQueried,...ms}));
}
if(process.argv[2]==='--analyze') console.log(JSON.stringify(analyze(JSON.parse(readFileSync(process.argv[3],'utf8'))),null,2));
else await withWorkflowLock(async()=>{
 assert.equal(process.argv.length,2,'Use no arguments, or --analyze <artifact>');
 const file=`ci-artifacts/tile-query-${Date.now().toString(36)}.json`;
 const report={mutated:false,observerSha256:createHash('sha256').update(code).digest('hex'),samples:[]};
 try {
  for(const host of [1,2]) assertLeaseClean(host,preflightState(host),'tile-query preflight');
  const selected=[];
  for(const host of [1,2]) {
   const roster=lua(host,"local result={}; for _,p in pairs(game.forces.player.platforms) do if p.valid then result[#result+1]={index=p.index,name=p.name} end end; return {success=true,platforms=result}");
   assert.equal(roster.success,true);
   for(const p of normalize(roster.platforms)) if(['lab-transfer-fixture-v1','lab-omnibus-state-v1','oneofeach-fixture-v1'].includes(p.name)) selected.push({host,...p});
  }
  assert.ok(selected.length>0 && selected.length<=3,'expected one to three unique existing pads');
  for(const p of selected) for(const first of [false,true]) {
   const command=`/sc local ok,result=pcall(function() return (function() ${code} end)()(${p.index},${first}) end); rcon.print(helpers.table_to_json(ok and result or {success=false,error=tostring(result)}))`;
   assert.ok(Buffer.byteLength(command)<=32768);
   const raw=docker(['exec','surface-export-controller','npx','clusterioctl','--config','/clusterio/tokens/config-control.json','--log-level','error','instance','send-rcon',HOSTS[p.host].instance,command],{timeout:20000,maxBuffer:16*1024*1024});
   const r=JSON.parse(raw.trim().split(/\r?\n/).at(-1)); assert.equal(r.success,true,r.error);
   r.host=p.host;r.raw={};r.ms={};
   for(const line of raw.split(/\r?\n/)) {
    const match=line.match(/\[SE_TILE_QUERY\](legacy|candidate)\t(.*)/);
    if(match){r.raw[match[1]]=match[2];r.ms[match[1]]=parseProfiler(match[2]);assert.ok(Number.isFinite(r.ms[match[1]]));}
   }
   report.samples.push(r);analyze(report);
   writeFileSync(file,JSON.stringify(report));
   console.log(JSON.stringify({platform:r.platform,first,generated:r.generated,retained:r.candidateQueried,ms:r.ms}));
  }
  report.verdict='PASS';
 } catch(error){report.verdict=error instanceof ParityFailure?'STOP':'HARNESS_ERROR';report.error=String(error);process.exitCode=report.verdict==='STOP'?2:1;}
 finally {writeFileSync(file,JSON.stringify(report));console.log(JSON.stringify({verdict:report.verdict,error:report.error,mutated:false,artifact:file}));}
});
