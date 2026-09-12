import test from 'node:test';
import assert from 'node:assert/strict';
import { runLab } from './lifecycle.mjs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

function fixture(options={}) {
 const report={},calls=[];
 const lab={cleanup:async()=>{calls.push('cleanup');return {success:true};}};
 return {report,lab,calls,run:extra=>runLab({lab,report,save:()=>calls.push('save'),
  work:async()=>{report.verdict='PASS';},...options,...extra})};
}
for(const signal of ['SIGINT','SIGTERM']) test(`${signal} cancels work and saves cleanup evidence`,async()=>{
 const f=fixture(),count=process.listenerCount(signal);
 assert.equal(await f.run({work:async()=>{process.emit(signal);assert.equal(f.lab.cancelled,true);}}),1);
 assert.equal(f.report.interrupted,signal);assert.equal(f.report.cleanup.success,true);
 assert.equal(f.report.verdict,'HARNESS_ERROR');assert.equal(process.listenerCount(signal),count);
 assert.deepEqual(f.calls,['save','cleanup','save']);
});
test('browser cleanup failure and Docker cleanup exception both retain evidence',async()=>{
 const f=fixture();
 assert.equal(await f.run({beforeCleanup:async()=>{throw Error('browser close');},cleanup:async()=>{
  f.calls.push('docker');throw Error('docker cleanup');}}),1);
 assert.deepEqual(f.calls,['save','docker','save']);
 assert.equal(f.report.cleanup.success,false);assert.equal(f.report.harnessErrors.length,2);
});
test('STOP uses exit 2 and setup errors use exit 1',async()=>{
 for(const [code,expected] of [['ACCEPTANCE_STOP',2],['FAIL',1]]) {
  const f=fixture();assert.equal(await f.run({work:async()=>{throw Object.assign(Error('probe'),{code});}}),expected);
  assert.equal(f.report.cleanup.success,true);
 }
});
test('oracle and evidence write failures cannot skip resource cleanup or leak signal handlers',async()=>{
 for(const fault of ['analyze','save']) {
  const f=fixture(),count=process.listenerCount('SIGINT');
  const options={[fault]:()=>{throw Error(fault);}};
  if(fault==='save')await assert.rejects(f.run(options),/save/);
  else assert.equal(await f.run(options),1);
  assert.equal(f.calls.includes('cleanup'),true);assert.equal(process.listenerCount('SIGINT'),count);
 }
});
test('intentional cleanup proof cannot mask failed cleanup or interruption',async()=>{
 for(const success of [true,false]) {
  const f=fixture();assert.equal(await f.run({work:()=>{throw Error('Intentional failure');},
   expectedFailure:/Intentional failure/,cleanup:async()=>({success})}),success?0:1);
  assert.equal(f.report.cleanupProofPassed,success);
 }
});
test('an oracle cannot certify a run whose work threw',async()=>{
 const f=fixture();assert.equal(await f.run({work:()=>{throw Error('setup');},analyze:()=>({verdict:'PASS'})}),1);
});
test('stage reporting failure preserves actual cleanup and captured log evidence',async()=>{
 for(const success of [true,false]) {
  const f=fixture(),observed={success,errors:success?[]:['owned volume remains'],logs:[{container:'owned',bytes:123}]};
  assert.equal(await f.run({cleanup:async()=>{f.report.cleanup=observed;throw Error('stage save');}}),1);
  assert.deepEqual(f.report.cleanup,observed);assert.match(f.report.error,/stage save/);
 }
});
test('actual upload runner handles OS termination during setup',{skip:process.platform==='win32'&&'Windows kill does not deliver POSIX signals',timeout:5000},async()=>{
 const child=spawn(process.execPath,[fileURLToPath(new URL('./lifecycle-child.mjs',import.meta.url))]);
 let output='',errors='',signalled=false;
 child.stderr.on('data',data=>errors+=data);
 child.stdout.on('data',data=>{output+=data;if(output.includes('READY')&&!signalled){signalled=true;child.kill('SIGTERM');}});
 const [code,signal]=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',(...args)=>resolve(args));});
 assert.equal(signal,null,errors);assert.equal(code,1,errors);assert.match(output,/CLEANUP/);
 const report=JSON.parse(output.split('\n').find(line=>line.startsWith('EVIDENCE ')).slice(9));
 assert.equal(report.interrupted,'SIGTERM');assert.equal(report.cleanup.success,true);
});
