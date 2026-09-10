import test from 'node:test';
import assert from 'node:assert/strict';
import {analyze} from './analyze.mjs';
const fixture=(extraGap=0)=>[
  JSON.stringify({v:1,id:'tickwatch-test',engine:'2.1.17',rows:121,truncated:false}),
  ...Array.from({length:121},(_,i)=>JSON.stringify({tick:i,speed:1,success:true})+`\tDuration: ${i*1000/60+(i>=60?extraGap:0)}ms\tDuration: 0.1ms\tDuration: 0.001ms`),
].join('\n');
test('measures ticks per independent elapsed interval',()=>{
  const r=analyze(fixture());assert.ok(Math.abs(r.averageUps-60)<1e-6);assert.ok(Math.abs(r.minRolling60TickUps-60)<1e-6);
});
test('measures a known 200 ms stall',()=>{
  const r=analyze(fixture(200));assert.ok(r.maxUpdateGapMs>216);assert.equal(r.gapsOver50ms,1);assert.ok(Math.abs(r.minRolling60TickUps-50)<1e-6);
});
test('does not hide a stall when catch-up restores average UPS',()=>{
  const lines=fixture().split('\n');
  for(let i=60;i<73;i++) {
    const fields=lines[i+1].split('\t');fields[1]=`Duration: ${1200+(i-60)*(1000/60-200/13)}ms`;lines[i+1]=fields.join('\t');
  }
  const r=analyze(lines.join('\n'));assert.ok(Math.abs(r.averageUps-60)<1e-6);assert.ok(r.maxUpdateGapMs>216);assert.ok(r.minRolling60TickUps<51);
});
test('rejects truncated and reset timelines instead of inventing UPS',()=>{
  assert.throws(()=>analyze(fixture().replace('"truncated":false','"truncated":true')));
  assert.throws(()=>analyze(fixture().replace('"tick":60','"tick":2')));
  assert.throws(()=>analyze(fixture().replace('Duration: 0.1ms','unavailable')));
});
