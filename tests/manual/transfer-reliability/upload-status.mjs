import { runLab } from './lifecycle.mjs';
import { checkRecoveryPreview } from '../../integration/canvas-motion/recovery.mjs';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DockerLab, ROOT, PLUGIN, hashTree } from './docker-lab.mjs';
import { summary, terminal, sample, recoveryCase } from './cases.mjs';
import { expectedCargo } from '../../integration/transfer-cleanup/oracle.mjs';
import { withWorkflowLock } from '../../../tools/shared/workflow-lock.mjs';
import { exportNotificationFailure, resolvedAdmissions, lostExportNotification, unresolvedAdmissionDiagnostics } from './upload-review-cases.mjs';

// Explicit candidate output; never builds, deploys, or reads the development cluster's saves.
const output=process.argv[2];
assert.ok(output,'Usage: node tests/manual/transfer-reliability/upload-status.mjs ci-artifacts/<candidate-dist>');
const candidate=resolve(ROOT,output);
assert.ok(candidate.startsWith(resolve(ROOT,'ci-artifacts')+'/') || candidate.startsWith(resolve(ROOT,'ci-artifacts')+'\\'));
const packageSource=process.argv[3] ? resolve(ROOT,process.argv[3]) : PLUGIN;
if(process.argv[3]) assert.ok(packageSource.startsWith(resolve(ROOT,'ci-artifacts')+'/') || packageSource.startsWith(resolve(ROOT,'ci-artifacts')+'\\'));
const selection=process.argv[4]||'all';
assert.ok(['all','notification','admitting','lost-notification','diagnostics'].includes(selection),'Unknown acceptance case selection');

await withWorkflowLock(async()=>{
  const run=`se-manual-upload-${randomUUID().slice(0,8)}`, directory=join(ROOT,'ci-artifacts',run);
  const bundle=join(directory,'candidate'); mkdirSync(bundle,{recursive:true});
  for(const part of ['module','package.json','package-lock.json','scripts']) cpSync(join(packageSource,part),join(bundle,part),{recursive:true});
  cpSync(candidate,join(bundle,'dist'),{recursive:true});
  const lab=new DockerLab(run,directory,{packageDirectory:bundle,exposeHttp:true});
  const report={run,selection,candidateHash:hashTree(bundle),started:new Date().toISOString(),
    invariant:'Receiving buffers are bounded and disposable; accepted attempts keep one job; queue/status observation never releases either platform.',
    oracle:'Independent physical fixture cargo, actual Lua job/attempt storage, controller history and browser status.',
    bounds:{startupSeconds:600,acceptanceSeconds:720,rconBytes:32768},
    limitations:['Scheduler delay and lost replies are deliberately injected; Factorio processing, saves, cargo and connections are real.','Capacity checks reserve declared bytes without allocating a 1 GiB test payload.'],cases:[]};
  const save=()=>writeFileSync(join(directory,'result.json'),JSON.stringify(report,null,2));
  const module=name=>`assert(package.loaded['__level__/modules/surface_export/${name}.lua'])`;
  const startQueued=index=>{
    const line=lab.ctl('surface-export','start-transfer',String(lab.ids[1]),String(index),String(lab.ids[2])).trim().split(/\r?\n/).at(-1);
    assert.ok(line.startsWith('Transfer queued: '),line);
    return {success:true,transferId:line.slice('Transfer queued: '.length)};
  };
  const call=(action,q)=>lab.lua(2,`local raw=remote.call('surface_export','upload_session_json','${action}',[==[${JSON.stringify({version:1,...q})}]==]);return {success=true,receipt=helpers.json_to_table(raw)}`).result.receipt;
  let sequence=0,epoch,limits;
  const begin=(name,bytes=2)=>call('begin',{epoch,sequence:++sequence,operationId:`${run}:${name}`,platformName:name,forceName:'player',totalBytes:bytes,totalChunks:Math.ceil(bytes/limits.chunkBytes)});
  let browser;
  save();
  process.exitCode=await runLab({lab,report,save,work:async()=>{
    console.log(`Starting ${run}`);
    report.environment=await lab.setup();save();lab.deadline=Date.now()+720_000;
    if(['all','notification'].includes(selection)) await exportNotificationFailure(lab,report,save,startQueued);
    if(['all','admitting'].includes(selection)) await resolvedAdmissions(lab,report,save);
    if(['all','lost-notification'].includes(selection)) await lostExportNotification(lab,report,save,startQueued);
    if(selection==='diagnostics') await unresolvedAdmissionDiagnostics(lab,report,save);
    if(selection!=='all') {report.verdict='PASS';return;}
    epoch=await lab.until(()=>lab.lua(2,'return {success=true,epoch=(storage.import_sessions or {}).epoch}').result.epoch,'upload protocol initialized');
    const handshake=call('initialize',{epoch});limits=handshake.limits;sequence=handshake.highWater;
    report.uploadLimits=limits;
    const receiving=begin('abandoned');assert.equal(receiving.state,'receiving');
    assert.equal(call('chunk',{attemptId:receiving.attemptId,index:1,data:'{}'}).receivedBytes,2);
    assert.equal(call('chunk',{attemptId:receiving.attemptId,index:1,data:'{}'}).receivedBytes,2);
    assert.equal(call('chunk',{attemptId:receiving.attemptId,index:1,data:'[]'}).success,false);
    assert.equal(call('abort',{attemptId:receiving.attemptId}).state,'aborted');
    assert.equal(call('chunk',{attemptId:receiving.attemptId,index:1,data:'{}'}).success,false);
    assert.equal(call('status',{attemptId:'missing'}).state,'unavailable');
    const slots=Array.from({length:limits.maxSessions},(_,i)=>begin(`slot-${i}`));
    assert.ok(slots.every(r=>r.state==='receiving'));assert.equal(begin('overflow').success,false);
    for(const r of slots) call('abort',{attemptId:r.attemptId});
    const reserved=[begin('large-a',limits.maxUploadBytes),begin('large-b',limits.maxUploadBytes)];
    assert.ok(reserved.every(r=>r.state==='receiving'));assert.equal(begin('aggregate-overflow').success,false);
    assert.equal(begin('too-large',limits.maxUploadBytes+1).success,false);
    for(const r of reserved)call('abort',{attemptId:r.attemptId});
    report.cases.push({name:'real protocol duplicates, closure and capacity',status:'PASS'});save();

    const incomplete=begin('save-receiving');
    const checkpoint=await lab.checkpoint('manual-upload-receiving',[2]);
    lab.ctl('instance','config','set',lab.hosts[2].instance,'instance.auto_start','false');
    await lab.load(2,'manual-upload-receiving',{crash:true});
    epoch=await lab.until(()=>{const e=lab.lua(2,'return {success=true,epoch=(storage.import_sessions or {}).epoch}').result.epoch;return e!==incomplete.epoch&&e;},'new sender epoch');
    sequence=0;
    assert.equal(call('status',{attemptId:incomplete.attemptId}).state,'aborted');
    report.cases.push({name:'saved receiving buffer retired after host process crash and new sender epoch',checkpoint,status:'PASS'});save();

    const name=`transfer-cleanup-${run}-queued`;
    const before=lab.probe(1,'build',name).state;assert.deepEqual(before.cargo,expectedCargo);
    // A fault at the scheduler boundary, not a pause of Factorio or a configured zero batch size.
    lab.lua(2,`local a=${module('core/async-processor')};_G.manual_upload_budget=a.get_max_concurrent_jobs;a.get_max_concurrent_jobs=function() return 0 end;return {success=true}`);
    const admission=startQueued(before.index);
    assert.equal(admission.success,true);report.admission=admission;save();
    const transferId=await lab.until(()=>lab.lua(2,`for _,r in pairs(storage.import_sessions.records) do if r.platform_name=='${name}' then return {success=true,id=r.operation_id} end end return {success=true}`).result.id,'controller-admitted upload');
    report.transferId=transferId;save();
    const accepted=await lab.until(()=>lab.lua(2,`for _,r in pairs(storage.import_sessions.records) do if r.operation_id=='${transferId}' and r.state=='accepted' then return {success=true,receipt={attemptId=r.id,jobId=r.job_id,state=r.state}} end end return {success=true}`).result.receipt,'real upload accepted');
    assert.equal(accepted.state,'accepted');
    const repeated=call('commit',{attemptId:accepted.attemptId});assert.equal(repeated.jobId,accepted.jobId);
    assert.equal(call('abort',{attemptId:accepted.attemptId}).state,'accepted');
    report.queued=await lab.until(()=>{const row=summary(lab,transferId);return row?.jobObservation?.state==='queued'&&row;},'queue wait observed beyond threshold',65);
    assert.equal(report.queued.status,'awaiting_validation');assert.equal(report.queued.completedAt??null,null);
    report.during={source:lab.probe(1,'read',name).state,
      destination:lab.lua(2,`local j=assert(storage.async_jobs['${accepted.jobId}']);local p=j.target_platform;return {success=true,present=p~=nil,hidden=p and p.hidden,paused=p and p.paused}`).result};
    assert.equal(report.during.source.usable,false);
    if(report.during.destination.present){assert.equal(report.during.destination.hidden,true);assert.equal(report.during.destination.paused,true);}
    report.expiry=lab.lua(1,`local count=0;for _,lock in pairs(storage.locked_platforms or {}) do if lock.platform_name=='${name}' then lock.expires_tick=game.tick-1;count=count+1 end end;assert(count==1);local s=${module('utils/surface-lock')}.scan_transfer_expiries();return {success=true,retained=table_size(storage.locked_platforms),summary=s}`).result;
    assert.equal(report.expiry.retained,1);assert.equal(report.expiry.summary.expired,0);
    const state=lab.lua(2,`local r=storage.import_sessions.records['${accepted.attemptId}'];return {success=true,hasBytes=r.chunks~=nil,jobCount=table_size(storage.async_jobs),status=${module('core/job-status')}.read(r.job_id)}`).result;
    assert.equal(state.hasBytes,false);assert.equal(state.jobCount,1);assert.equal(state.status.state,'queued');report.lua=state;save();
    const {chromium}=await import('playwright');browser=await chromium.launch({headless:true});
    const page=await browser.newPage();
    const token=JSON.parse(lab.docker(['exec',lab.controller,'cat','/clusterio/tokens/config-control.json']))['control.controller_token'];
    await page.goto(lab.url);await page.evaluate(t=>localStorage.setItem('controller_token',t),token);
    await page.goto(`${lab.url}/surface-export?tab=logs&transfer=${encodeURIComponent(transferId)}`);
    await page.getByTestId('job-observation').filter({hasText:'Waiting in Lua queue'}).waitFor({timeout:20_000});
    await page.screenshot({path:join(directory,'queued.png'),fullPage:true});
    report.cases.push({name:'queued beyond 30 seconds, repeated commit and browser presentation',status:'PASS'});save();
    await page.goto(`${lab.url}/surface-export?tab=gateways`);
    await page.getByRole('button',{name:'toggle debug mode',exact:true}).click();
    await checkRecoveryPreview(page);
    report.cases.push({name:'recovery marker stays unresolved and visible beyond terminal fade',status:'PASS'});save();

    // Controller restart must observe the existing job, never replay admission or call failure cleanup.
    lab.mutateContainer('kill',lab.controller,['--signal','KILL']);lab.mutateContainer('start',lab.controller);
    await lab.ready();
    report.afterRestart=await lab.until(()=>{const row=summary(lab,transferId);return row?.jobObservation?.state==='queued'&&row;},'queued job reobserved after controller restart',65);
    assert.equal(report.afterRestart.status,'awaiting_validation');assert.equal(report.afterRestart.completedAt??null,null);
    const nextName=`transfer-cleanup-${run}-next`;
    const nextBefore=lab.probe(1,'build',nextName).state;
    assert.deepEqual(nextBefore.cargo,expectedCargo);
    const nextAdmission=startQueued(nextBefore.index);
    assert.equal(nextAdmission.success,true);
    assert.equal(summary(lab,nextAdmission.transferId).status,'queued','unresolved import did not reserve its endpoints');
    // Visits without cursor changes are not progress. This bounded injection cannot mutate cargo.
    lab.lua(2,`local p=${module('core/import-pipeline')};_G.manual_upload_batch=p.process_batch;p.process_batch=function() return false end;local a=${module('core/async-processor')};a.get_max_concurrent_jobs=assert(_G.manual_upload_budget);return {success=true}`);
    report.stalled=await lab.until(()=>{const row=summary(lab,transferId);return row?.jobObservation?.message==='No progress observed'&&row;},'unchanged work reported without cancellation',65);
    assert.equal(report.stalled.status,'awaiting_validation');assert.equal(report.stalled.completedAt??null,null);
    lab.lua(2,`local j=assert(storage.async_jobs['${accepted.jobId}']);j.pending_beacon_tick=game.tick+3600;return {success=true}`);
    report.deferred=await lab.until(()=>{const row=summary(lab,transferId);return row?.jobObservation?.state==='waiting'&&row;},'explicit deferred wait',15);
    lab.lua(2,`local j=assert(storage.async_jobs['${accepted.jobId}']);j.pending_beacon_tick=nil;local p=${module('core/import-pipeline')};p.process_batch=assert(_G.manual_upload_batch);_G.manual_upload_batch=nil;return {success=true}`);
    lab.lua(2,`local a=${module('core/async-processor')};a.get_max_concurrent_jobs=assert(_G.manual_upload_budget);_G.manual_upload_budget=nil;return {success=true}`);
    report.outcome=await terminal(lab,transferId);assert.equal(report.outcome.status,'completed');
    report.after=sample(lab,name);assert.equal(report.after.source.present,false);assert.equal(report.after.destination.usable,true);
    assert.deepEqual(report.after.destination.cargo,expectedCargo);assert.equal(report.after.destination.canary.active,true);
    const nextId=await lab.until(()=>lab.lua(2,`for _,r in pairs(storage.import_sessions.records) do if r.platform_name=='${nextName}' then return {success=true,id=r.operation_id} end end return {success=true}`).result.id,'queued successor admitted after resolution');
    report.nextOutcome=await terminal(lab,nextId);assert.equal(report.nextOutcome.status,'completed');
    report.nextCargo=sample(lab,nextName);assert.equal(report.nextCargo.source.present,false);
    assert.deepEqual(report.nextCargo.destination.cargo,expectedCargo);assert.equal(report.nextCargo.destination.usable,true);
    report.cases.push({name:'controller restart then original job completion, independent cargo parity',status:'PASS'});save();
    report.completedCheckpoint=await lab.checkpoint('manual-upload-completed');
    await lab.load(2,'manual-upload-completed');
    report.reloaded=sample(lab,name);
    assert.deepEqual(report.reloaded.destination.cargo,expectedCargo);assert.equal(report.reloaded.destination.usable,true);
    assert.equal(call('commit',{attemptId:accepted.attemptId}).jobId,accepted.jobId);
    report.cases.push({name:'completed attempt and physical cargo survive save/reload',status:'PASS'});save();
    await browser.close();browser=undefined;

    // Standalone recovery imports use the same observer, including after a controller restart.
    const restoredName=`transfer-cleanup-${run}-snapshot`;
    lab.lua(2,`local a=${module('core/async-processor')};_G.manual_upload_budget=a.get_max_concurrent_jobs;a.get_max_concurrent_jobs=function() return 0 end;return {success=true}`);
    const requestId=randomUUID();
    const restored=JSON.parse(lab.ctl('surface-export','restore-snapshot',transferId,String(lab.ids[2]),requestId,restoredName).trim().split(/\r?\n/).at(-1));
    assert.ok(restored.operationId);report.restoredOperationId=restored.operationId;save();
    report.standaloneQueued=await lab.until(()=>{const row=summary(lab,restored.operationId);return row?.jobObservation?.state==='queued'&&row;},'standalone queued import',65);
    assert.equal(report.standaloneQueued.status,'awaiting_completion');assert.equal(report.standaloneQueued.completedAt??null,null);
    lab.mutateContainer('kill',lab.controller,['--signal','KILL']);lab.mutateContainer('start',lab.controller);await lab.ready();
    report.standaloneRestart=await lab.until(()=>{const row=summary(lab,restored.operationId);return row?.jobObservation?.state==='queued'&&row;},'standalone observation after restart',65);
    assert.equal(report.standaloneRestart.status,'awaiting_completion');
    // The accepted receipt and job are both saved. Reload resumes that job, not a new upload.
    report.acceptedCheckpoint=await lab.checkpoint('manual-upload-accepted',[2]);
    await lab.load(2,'manual-upload-accepted',{crash:true});
    report.standaloneOutcome=await terminal(lab,restored.operationId);assert.equal(report.standaloneOutcome.status,'completed');
    report.restoredCargo=lab.probe(2,'read',restoredName).state;
    assert.deepEqual(report.restoredCargo.cargo,expectedCargo);assert.equal(report.restoredCargo.usable,true);
    report.cases.push({name:'standalone queued import, controller restart and accepted-job save/reload',status:'PASS'});save();

    // Exercise the actual browser download request, whose awaiting handler disappears at restart.
    const exportName=`transfer-cleanup-${run}-download`;
    report.exportBefore=lab.probe(1,'build',exportName).state;
    assert.deepEqual(report.exportBefore.cargo,expectedCargo);
    lab.lua(1,`local a=${module('core/async-processor')};_G.manual_upload_budget=a.get_max_concurrent_jobs;a.get_max_concurrent_jobs=function() return 0 end;return {success=true}`);
    browser=await chromium.launch({headless:true});
    const exportPage=await browser.newPage();
    await exportPage.goto(lab.url);await exportPage.evaluate(t=>localStorage.setItem('controller_token',t),token);
    await exportPage.goto(`${lab.url}/surface-export?tab=gateways`);
    await exportPage.locator('.react-flow__node').filter({hasText:lab.hosts[1].instance}).click();
    await exportPage.locator('.surface-export-platform-node-row').filter({hasText:exportName}).getByRole('button').click();
    report.exportQueued=await lab.until(()=>{
      const rows=JSON.parse(lab.ctl('surface-export','list-transfers','200').trim().split(/\r?\n/).at(-1));
      return rows.find(row=>row.operationType==='export'&&row.sourceInstanceId===lab.ids[1]
        && (row.jobObservation?.state==='queued'||['failed','error','completed'].includes(row.status)));
    },'standalone source export queued',65);save();
    assert.equal(report.exportQueued.jobObservation?.state,'queued',report.exportQueued.error||'expected queued source work');
    lab.mutateContainer('kill',lab.controller,['--signal','KILL']);lab.mutateContainer('start',lab.controller);await lab.ready();
    lab.lua(1,`local a=${module('core/async-processor')};a.get_max_concurrent_jobs=assert(_G.manual_upload_budget);_G.manual_upload_budget=nil;return {success=true}`);
    report.exportRecovered=await terminal(lab,report.exportQueued.transferId);
    assert.equal(report.exportRecovered.status,'completed');
    assert.equal(report.exportRecovered.observedDurationMs??null,null);
    report.exportAfter=sample(lab,exportName);
    assert.deepEqual(report.exportAfter.source.cargo,expectedCargo);assert.equal(report.exportAfter.destination.present,false);
    report.cases.push({name:'browser export resumes observation after controller restart and confirms stored artifact',status:'PASS'});save();
    await browser.close();browser=undefined;

    // Reuse the existing failed-preparation probe and its independent physical assertions.
    const cleanupLua=readFileSync(join(ROOT,'tests/manual/transfer-reliability/setup-cleanup.lua'),'utf8');
    const cleanupProbe=(action,id)=>lab.lua(1,`return (function() ${cleanupLua} end)()('${action}','${id}')`).result;
    report.cleanupPending=cleanupProbe('fail',run);
    assert.equal(report.cleanupPending.status.state,'cleanup-pending');
    report.cleanupCheckpoint=await lab.checkpoint('manual-upload-cleanup',[1]);
    await lab.load(1,'manual-upload-cleanup');
    cleanupProbe('retry',report.cleanupPending.job);
    report.cleanupResult=await lab.until(()=>{const row=cleanupProbe('inspect',report.cleanupPending.job);return !row.pending&&row;},'failed preparation cleanup after reload',30);
    assert.equal(report.cleanupResult.result.status,'failed');
    assert.equal(Object.keys(report.cleanupResult.holds).length,0);
    report.cases.push({name:'failed preparation retains cleanup-pending state across save/reload',status:'PASS'});save();
    for(const testCase of ['lost-source-reply','lost-destination-reply']) {
      const result={case:testCase};report.cases.push(result);save();
      await recoveryCase(lab,result,save);assert.equal(result.outcome.status,'completed');
      for(const observation of result.samples.slice(-2)) {
        assert.equal(observation.source.present,false);assert.equal(observation.destination.usable,true);
        assert.deepEqual(observation.destination.cargo,expectedCargo);
      }
      result.status='PASS';save();
    }
    report.verdict='PASS';
  },beforeCleanup:()=>browser?.close()});
  console.log(JSON.stringify({verdict:report.verdict,error:report.error,cleanup:report.cleanup.success,artifact:join(directory,'result.json')},null,2));
});
