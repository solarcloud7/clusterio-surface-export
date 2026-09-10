import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { withWorkflowLock } from '../../../tools/shared/workflow-lock.mjs';
import { lua, rcon, preflightState, assertLeaseClean } from '../../lab-gallery/batch-lifecycle.mjs';

const mode = process.argv[2];
assert.ok(['--run', '--cleanup-proof', '--analyze'].includes(mode));
if (mode === '--analyze') {
  const report = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  console.log(JSON.stringify({verdict:report.verdict, trials:report.trials?.map(compact),cleanup:report.cleanup},null,2));
} else await withWorkflowLock(run);

function compact(trial) {
  const values=trial.readings.map(r=>r.ms);
  return {mode:trial.mode,calls:values.length,maxMs:Math.max(...values),totalMs:values.reduce((a,b)=>a+b,0),exactPayload:trial.readings.at(-1)?.done===true};
}
async function run() {
  const id=`decodebudget-${Date.now().toString(36)}`;
  const exportId=process.argv[3] || '178_transfer-cleanup-tickwatch-mtuop1r6';
  assert.match(exportId,/^\d+_transfer-cleanup-[a-z0-9-]+$/,'owned test export required');
  const payloadPath=process.argv[4] || 'ci-artifacts/import-setup-exact-payload.json';
  const payloadRaw=readFileSync(payloadPath);
  const payload=JSON.parse(payloadRaw);
  const code=readFileSync(new URL('./decode-budget.lua',import.meta.url),'utf8');
  const ranges=[];
  // Whole records only. 60 KiB leaves room for native encoding differences.
  for(const key of ['entities','tiles','belt_side_groups']) {
    const values=payload[key];assert.ok(Array.isArray(values));
    let first=0,bytes=key.length+8;
    for(let i=0;i<values.length;i++) {
      const size=Buffer.byteLength(JSON.stringify(values[i]))+1;
      assert.ok(size<60000,'one record exceeds the experiment budget');
      if(bytes+size>60000&&i>first){ranges.push({key,first:first+1,last:i});first=i;bytes=key.length+8;}
      bytes+=size;
    }
    ranges.push({key,first:first+1,last:values.length});
  }
  const report={id,mode,exportId,payloadPath,payloadSha256:createHash('sha256').update(payloadRaw).digest('hex'),
    probeSha256:createHash('sha256').update(code).digest('hex'),trials:[],verdict:'HARNESS_ERROR',
    runnerSha256:createHash('sha256').update(readFileSync(new URL('./decode-budget.mjs',import.meta.url))).digest('hex'),
    contract:'Two full and two sectional decode trials on unoccupied host-2; at most 100 parts and 210 calls; one native decode per RCON callback, distinct ticks; exact full payload equality. Preparation, oracle and transport outside measured spans; deferred GC not isolated. No game-world or production changes.'};
  const invoke=(action,arg)=>{
    const argLua=arg===undefined?'nil':`helpers.json_to_table([==[${JSON.stringify(arg)}]==])`;
    const body=`local p=(function() ${code} end)();return p('${action}','${id}',${argLua})`;
    assert.ok(Buffer.byteLength(body)<32768);
    const raw=rcon(2,`/sc local ok,v=pcall(function() ${body} end);rcon.print(helpers.table_to_json(ok and v or {success=false,error=tostring(v)}))`);
    const value=JSON.parse(raw.trim().split(/\r?\n/).at(-1));assert.equal(value.success,true,value.error);
    return {raw,value};
  };
  let touched=false,failure;
  try {
    assertLeaseClean(2,preflightState(2),'decode-budget preflight');
    const actual=lua(2,`local e=assert(storage.platform_exports['${exportId}']);return {success=true,json=helpers.decode_string(e.payload)}`);
    assert.equal(actual.success,true,actual.error);
    assert.equal(actual.json,payloadRaw.toString('utf8'),'local payload is not the current source cache');
    touched=true;report.setup=invoke('prepare',{export_id:exportId,ranges}).value;
    if(mode==='--cleanup-proof')throw new Error('intentional decode-budget runner failure');
    let calls=0;const deadline=Date.now()+240000;
    for(const trialMode of ['full','parts','parts','full']) {
      invoke('begin',trialMode);const trial={mode:trialMode,readings:[]};report.trials.push(trial);
      for(let i=0;i<100;i++) {
        assert.ok(++calls<=210 && Date.now()<deadline,'experiment deadline/call budget exceeded');
        const {raw,value}=invoke('step');
        const match=raw.match(/\[SE_DECODE_BUDGET_V1\]Duration: (\d+(?:\.\d+)?)(ms|s)/);
        assert.ok(match,'missing profiler reading');
        const ms=Number(match[1])*(match[2]==='s'?1000:1);assert.ok(Number.isFinite(ms));
        trial.readings.push({...value,ms,raw});
        if(value.done)break;
      }
      assert.equal(trial.readings.at(-1).exactPayload,true);
      console.log(compact(trial));
    }
    report.verdict='PASS';
  } catch(error){failure=error;report.error=error.stack;}
  finally {
    if(touched)try {
      report.cleanup=invoke('cleanup').value;
      assert.equal(invoke('status').value.present,false);
      assertLeaseClean(2,preflightState(2),'decode-budget postflight');
    }catch(error){report.cleanupError=error.stack;failure=error;report.verdict='HARNESS_ERROR';}
    report.cleanupProofPassed=mode==='--cleanup-proof' && failure?.message==='intentional decode-budget runner failure' && !report.cleanupError;
    writeFileSync(`ci-artifacts/${id}.json`,JSON.stringify(report,null,2));
    console.log({id,verdict:report.verdict,cleanupProofPassed:report.cleanupProofPassed,error:failure?.message,cleanup:report.cleanup});
  }
  if(failure&&!report.cleanupProofPassed)process.exitCode=1;
}
