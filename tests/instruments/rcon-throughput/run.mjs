import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { withWorkflowLock } from '../../../tools/shared/workflow-lock.mjs';
import { lua, preflightState } from '../../lab-gallery/batch-lifecycle.mjs';

export function analyze(report) {
  assert.equal(report.verdict,'PASS',report.error);
  assert.ok(['1000,10000,100000','100000,10000'].includes(report.contract.chunkSizes.join(',')));
  assert.deepEqual(report.cases.map(c=>c.chunkSize),report.contract.chunkSizes);
  return report.cases.map(c=>{
    assert.equal(c.payloadBytes,100000); assert.equal(c.samples.length,100000/c.chunkSize);
    for(const s of c.samples) { assert.equal(s.bytes,c.chunkSize); assert.ok(Number.isFinite(s.elapsedMs)&&s.elapsedMs>=0); }
    return {chunkSize:c.chunkSize,commands:c.samples.length,totalSeconds:c.elapsedMs/1000,maxAcknowledgementMs:c.maxAcknowledgementMs,maxLuaExecutionMs:c.maxLuaExecutionMs};
  });
}
if(process.argv[2]==='--analyze') console.table(analyze(JSON.parse(readFileSync(process.argv[3],'utf8'))));
else await withWorkflowLock(async()=>{
  const comparison=process.argv.includes('--compare-100k-10k');
  assert.deepEqual(process.argv.slice(2),comparison?['--supervised-client','--compare-100k-10k']:['--supervised-client'],'explicit supervised-client mode required');
  for(const host of [1,2]) {
    const s=preflightState(host); assert.equal(s.success,true); assert.equal(s.paused,false);
    for(const k of ['jobs','locks','holds'])assert.equal(s[k],0,`host ${host}: ${k}`);
    assert.equal(s.players,host===1?1:0,'unexpected connected players');
  }
  const p=lua(1,"local p=game.get_player('solarcloud7');return {success=p and p.connected or false}");assert.equal(p.success,true);
  const code=readFileSync(new URL('./probe.cjs',import.meta.url),'utf8');
  const artifact=`ci-artifacts/rcon-throughput-${Date.now().toString(36)}.json`;
  const report=await new Promise((resolve,reject)=>{
    const child=spawn('docker',['exec','-i','surface-export-host-1','node','-',...(comparison?['--compare-100k-10k']:[])],{stdio:['pipe','pipe','pipe']});
    let pending='',result,stderr='';
    const timer=setTimeout(()=>{child.kill();reject(new Error('Runner exceeded 210 second budget; stateless commands may still be in flight'));},210000);
    child.stdout.on('data',chunk=>{pending+=chunk;const lines=pending.split('\n');pending=lines.pop();for(const line of lines){if(!line.trim())continue;try{const event=JSON.parse(line);if(event.event==='report')result=event.report;else console.log(event);}catch(error){console.warn("Probe emitted a non-JSON line:",error.message);stderr+=line.slice(0,300);}}});
    child.stderr.on('data',chunk=>{stderr+=String(chunk).slice(0,2000);});
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',exit=>{clearTimeout(timer);if(result)resolve(result);else reject(new Error(`Probe exited ${exit} without report: ${stderr}`));});
    child.stdin.end(code);
  });
  report.instrumentSha256=createHash('sha256').update(code).update(readFileSync(new URL(import.meta.url))).digest('hex');
  writeFileSync(artifact,JSON.stringify(report,null,2)); console.log({artifact,verdict:report.verdict});
  console.table(analyze(report));
});
