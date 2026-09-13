import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { DockerLab, ROOT, hash } from './docker-lab.mjs';
import { runLab } from './lifecycle.mjs';
import { withWorkflowLock } from '../../../tools/shared/workflow-lock.mjs';

const { values } = parseArgs({ options: { 'package-dir': { type: 'string' } } });
await withWorkflowLock(async () => {
  const run=`se-manual-setup-${randomUUID().slice(0,8)}`;
  const directory=join(ROOT,'ci-artifacts',run);
  mkdirSync(directory,{recursive:true});
  const lab=new DockerLab(run,directory,{packageDirectory:values['package-dir']});
  const observer=join(ROOT,'tests/manual/transfer-reliability/setup-cleanup.lua');
  const lua=readFileSync(observer,'utf8');
  const report={run,started:new Date().toISOString(),fixture:hash(observer),
    runner:hash(join(ROOT,'tests/manual/transfer-reliability/setup-cleanup.mjs')),
    invariant:'Refused deletion retains one protected failed destination across save/reload; scheduler retry removes only that destination and retains the failed result.',
    oracle:'Physical platform/surface identity, hidden and paused flags, hub contents, job and hold storage.',
    bounds:{startupSeconds:600,acceptanceSeconds:300,cleanupPolls:30,rconBytes:32768},
    limitations:['Preparation and deletion errors are injected at module boundaries in an isolated cluster.','This does not simulate a Factorio crash or a connected player.']};
  const save=()=>writeFileSync(join(directory,'result.json'),JSON.stringify(report,null,2));
  const probe=(action,name)=>{
    assert.match(name,/^[a-z0-9_-]+$/);
    return lab.lua(1,`return (function() ${lua} end)()('${action}','${name}')`).result;
  };
  process.exitCode=await runLab({lab,report,save,work:async()=>{
    console.log(`Starting ${run}`);
    report.environment=await lab.setup();save();
    lab.deadline=Date.now()+300_000;
    report.controls=probe('controls',run);save();
    report.refusal=probe('fail',run);save();
    assert.equal(report.refusal.engine,'2.1.17');
    report.checkpoint=await lab.checkpoint('manual-setup-cleanup',[1]);save();
    await lab.load(1,'manual-setup-cleanup');
    report.retry=probe('retry',report.refusal.job);save();
    assert.equal(report.retry.platform,report.refusal.platform);
    assert.equal(report.retry.surface,report.refusal.surface);
    for(let poll=0;poll<report.bounds.cleanupPolls;poll++) {
      report.after=probe('inspect',report.refusal.job);
      if(!report.after.pending) break;
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    assert.equal(report.after.pending,false,'scheduler cleanup did not complete');
    assert.equal(report.after.result.status,'failed');
    assert.equal(report.after.result.validation.success,false);
    assert.equal(Object.keys(report.after.holds).length,0);
    report.physical=lab.lua(1,`return {success=true,
      platformExists=game.forces.player.platforms[${report.refusal.platform}]~=nil,
      surfaceExists=game.surfaces[${report.refusal.surface}]~=nil,
      paused=game.tick_paused}`).result;
    assert.equal(report.physical.platformExists,false);
    assert.equal(report.physical.surfaceExists,false);
    assert.equal(report.physical.paused,false);
    report.verdict='PASS';
  }});
  console.log(JSON.stringify({verdict:report.verdict,error:report.error,cleanup:report.cleanup.success,artifact:join(directory,'result.json')},null,2));
});
