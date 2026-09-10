import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {inflateSync,gunzipSync} from 'node:zlib';
import {withWorkflowLock} from '../../../tools/shared/workflow-lock.mjs';
import {lua,preflightState,assertLeaseClean} from '../../lab-gallery/batch-lifecycle.mjs';

const mode=process.argv[2];
assert.ok(['--run','--cleanup-proof','--analyze','--recorded','--cleanup'].includes(mode));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function analyze(r) {
  assert.equal(r.verdict,'PASS',r.error);assert.equal(r.cleanup.removed,true);assert.equal(r.residue.present,false);
  assert.deepEqual(r.cases.map(c=>c.scale),[1,2,4]);
  return r.cases.flatMap(c=>{assert.equal(c.trials.length,2);return c.trials.map(t=>{
    assert.equal(t.verification.exactPayload,true);assert.equal(t.control.exactPayload,true);
    for(const side of ['source','destination']) {
      assert.equal(t[side].length,t.frames);
      for(let i=0;i<t[side].length;i++) {
        assert.equal(t[side][i].seq,i+1);
        assert.ok(t[side][i].readings.every(v=>Number.isFinite(v.ms)&&v.ms>=0));
        if(i)assert.ok(t[side][i].tick>t[side][i-1].tick);
      }
    }
    return {scale:c.scale,repeat:t.repeat,frames:t.frames,MB:t.jsonBytes/1e6,
      fullCompressMs:t.control.compressionMs,fullDecodeMs:t.control.decodeMs,
      maxEncodeMs:t.maxSourceEncodeMs,maxDecodeMs:t.maxDestinationDecodeMs,
      maxSourceActionMs:t.maxSourceActionMs,maxDestinationActionMs:t.maxDestinationActionMs,
      fullBytes:t.control.encodedBytes,sectionBytes:t.encodedBytes,nodeCompressAwaitMs:t.nodeCompressionAwaitMs,
      jsonlGzipBytes:t.jsonlGzip.gzipBytes};
  });});
}
if(mode==='--recorded') {
  const root=new URL('./evidence/',import.meta.url);
  const manifest=JSON.parse(readFileSync(new URL('codec-2.1.17.manifest.json',root),'utf8'));
  const packed=readFileSync(new URL('codec-2.1.17.json.gz',root));
  assert.equal(hash(packed),manifest.sha256);
  const raw=gunzipSync(packed);assert.equal(hash(raw),manifest.decodedSha256);
  const bundle=JSON.parse(raw);assert.equal(bundle.version,1);
  const reports=bundle.reports.map(text=>JSON.parse(text));
  assert.deepEqual(reports.map(r=>r.id),manifest.reportIds);
  for(const r of reports)for(const [key,value] of Object.entries({...bundle.sources,payload:bundle.payload,api:bundle.api})) {
    assert.equal(hash(value),r.hashes[key],`${r.id}: ${key} provenance mismatch`);
  }
  const [proof,matrix]=reports;
  assert.equal(proof.cleanupProofPassed,true);assert.equal(proof.cleanup.removed,true);
  assert.equal(proof.residue.present,false);assert.equal(proof.postflight,'PASS');
  assert.equal(matrix.postflight,'PASS');
  console.table(analyze(matrix));
  console.log('Recorded evidence hashes, original harness, cleanup proof and six codec trials verified. No cluster calls.');
} else if(mode==='--analyze')console.table(analyze(JSON.parse(readFileSync(process.argv[3],'utf8'))));
else await withWorkflowLock(async()=>{
  if(mode==='--cleanup') {
    const id=process.argv[3];assert.match(id,/^codecscale-[a-z0-9]+$/);
    const result=lua(2,`local s=package.loaded.surface_export_codec_scaling_lab;if not s then return {success=true,removed=true} end;return s.invoke('cleanup','${id}')`);
    assert.equal(result.success,true,result.error);console.log(result);return;
  }
  const id=`codecscale-${Date.now().toString(36)}`;
  const exportId=process.argv[3] || '178_transfer-cleanup-tickwatch-mtuop1r6';
  assert.match(exportId,/^[A-Za-z0-9_:.-]+$/,'invalid export cache ID');
  const raw=readFileSync(process.argv[4] || 'ci-artifacts/import-setup-exact-payload.json'),payload=JSON.parse(raw);
  const luaCode=readFileSync(new URL('./codec-scaling.lua',import.meta.url),'utf8');
  const nodeCode=readFileSync(new URL('./codec-scaling.cjs',import.meta.url),'utf8');
  const apiRaw=readFileSync(process.argv[5] || 'ci-artifacts/issue-69-runtime-api.json');const api=JSON.parse(apiRaw);
  assert.equal(api.application_version,'2.1.17');
  const members={LuaHelpers:['create_profiler','decode_string','encode_string','json_to_table','table_to_json'],
    LuaProfiler:['stop'],LuaGameScript:['connected_players','tick_paused','tick'],LuaBootstrap:['active_mods'],LuaRCON:['print']};
  for(const [name,required] of Object.entries(members)) {
    const cls=api.classes.find(c=>c.name===name);assert.ok(cls,`missing API class ${name}`);
    for(const member of required)assert.ok([...cls.methods,...cls.attributes].some(m=>m.name===member),`missing API ${name}.${member}`);
  }
  const ranges=[];
  for(const key of ['entities','tiles','belt_side_groups']) {
    const values=payload[key];assert.ok(Array.isArray(values));let first=0,bytes=150;
    for(let i=0;i<values.length;i++) {
      const size=Buffer.byteLength(JSON.stringify(values[i]))+1;assert.ok(size<59000);
      if(bytes+size>59000&&i>first){ranges.push({key,first:first+1,last:i});first=i;bytes=150;}
      bytes+=size;
    }
    ranges.push({key,first:first+1,last:values.length});
  }
  const input={id,exportId,ranges,lua:luaCode,cleanupProof:mode==='--cleanup-proof',
    hashes:{lua:hash(luaCode),node:hash(nodeCode),runner:hash(readFileSync(new URL(import.meta.url))),payload:hash(raw),api:hash(apiRaw)},
    contract:{engine:'2.1.17',scales:[1,2,4],repeats:2,scaleDefinition:'Copies of the captured 3.09 MB payload in a codec container, not physically larger platforms.',
      invariant:'All fields and values in each decoded copy equal the captured source; sequence/range checks; archive text round trips exactly.',
      route:'Both Factorio codec endpoints on unoccupied host-2; external async compression in Node in that container; direct persistent localhost RCON.',
      bounds:'At most 100 sections per copy, 4 copies, 2 trials per scale, 2200 requests, 360s loop deadline, 30s RCON timeout, 100000-byte requests, 300000-character responses. Native frame <=65536 bytes.',
      mutation:'Temporary package state only; no surfaces/entities/jobs/event hooks/save/config changes. Original export cache retained.',
      timing:'Phase profilers plus RCON action/reply-construction profiler. Compilation and socket wait excluded from Lua readings; recorded RCON RTT separate. Oracle/setup actions are lab overhead.',
      limits:'Preparation, monolithic JSON assembly, source capture, network transport across instances, production recovery and client FPS/UPS are not acceptance-tested here. Deferred garbage collection is not isolated.'}};
  assertLeaseClean(2,preflightState(2),'codec scaling preflight');
  const cached=lua(2,`local e=assert(storage.platform_exports['${exportId}']);return {success=true,payload=e.payload}`);
  assert.equal(cached.success,true,cached.error);assert.equal(hash(inflateSync(Buffer.from(cached.payload,'base64'))),hash(raw));
  const report=await new Promise((resolve,reject)=>{
    const child=spawn('docker',['exec','-i','surface-export-host-2','node','-'],{stdio:['pipe','pipe','pipe']});
    let pending='',result,stderr='';
    const timer=setTimeout(()=>{child.kill();reject(Error(`Outer deadline exceeded. Verify stopped runner, then use --cleanup ${id}; do not assume removal.`));},450000);
    child.stdout.on('data',chunk=>{
      pending+=chunk;const lines=pending.split('\n');pending=lines.pop();
      for(const line of lines)if(line.trim())try{const event=JSON.parse(line);if(event.event==='report')result=event.report;else console.log(event);}catch(error){console.warn("Probe emitted a non-JSON line:",error.message);stderr+=line.slice(0,500);}
    });
    child.stderr.on('data',chunk=>{stderr+=String(chunk).slice(0,1000);});
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',exit=>{clearTimeout(timer);result?resolve(result):reject(Error(`Codec runner exited ${exit}: ${stderr}`));});
    child.stdin.end(nodeCode+`\nrun(${JSON.stringify(input)}).catch(e=>{console.error(e.message);process.exitCode=1;});\n`);
  });
  try{assertLeaseClean(2,preflightState(2),'codec scaling postflight');report.postflight='PASS';}
  catch(error){report.postflightError=error.message;report.verdict='HARNESS_ERROR';}
  const file=`ci-artifacts/${id}.json`;writeFileSync(file,JSON.stringify(report,null,2));
  console.log({artifact:file,verdict:report.verdict,error:report.error,cleanup:report.cleanup,cleanupProofPassed:report.cleanupProofPassed});
  if(report.verdict==='PASS')console.table(analyze(report));
  else if(!report.cleanupProofPassed||report.postflightError)process.exitCode=1;
});
