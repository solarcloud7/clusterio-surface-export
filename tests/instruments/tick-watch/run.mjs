import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { withWorkflowLock } from '../../../tools/shared/workflow-lock.mjs';
import { preflightState, sleep } from '../../lab-gallery/batch-lifecycle.mjs';
import { capture } from './capture.mjs';

const mode=process.argv[2];assert.ok(['--idle','--rcon','--cleanup-proof'].includes(mode),'choose --idle, --rcon, or --cleanup-proof');
await withWorkflowLock(async()=>{
  for(const host of [1,2]) {
    const s=preflightState(host);assert.equal(s.success,true);assert.equal(s.paused,false);
    for(const key of ['jobs','locks','holds'])assert.equal(s[key],0,`host ${host} ${key}`);
    assert.equal(s.players,host===1?1:0,'requires supervised local client');
  }
  if(mode==='--cleanup-proof') {
    await assert.rejects(()=>capture(async()=>{await sleep(1500);throw new Error('intentional runner failure');}),/intentional runner failure/);
    console.log('PASS: intentional runner failure propagated and recorder removal verified.');return;
  }
  await capture(async()=>{
    if(mode==='--idle'){await sleep(5000);return {mode,seconds:5};}
    await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,['tests/instruments/rcon-throughput/run.mjs','--supervised-client','--compare-100k-10k'],{stdio:'inherit'});
      child.on('error',reject);child.on('close',exit=>exit===0?resolve():reject(new Error(`RCON comparison exited ${exit}`)));
    });return {mode};
  });
});
