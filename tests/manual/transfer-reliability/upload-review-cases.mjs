import assert from 'node:assert/strict';
import { summary, sample } from './cases.mjs';
import { expectedCargo } from '../../integration/transfer-cleanup/oracle.mjs';

export async function resolvedAdmissions(lab, report, save) {
  const module=name=>`assert(package.loaded['__level__/modules/surface_export/${name}.lua'])`;
  const result={name:'admitting receipts release staging slots after matching jobs resolve',status:'RUNNING'};
  report.cases.push(result);save();
  result.receipts=lab.lua(2,`local sessions=${module('core/import-session')};local async=${module('core/async-processor')};local saved={}
    for index=1,4 do
      local operation='${lab.run}:admitting-'..index
      local name='${lab.run}-admitting-'..index
      local payload=helpers.table_to_json({schema_version='2.0.0',factorio_version=script.active_mods.base,
        _operationId=operation,platform_name=name,platform={force='player'},entities={},tiles={}})
      local q={version=1,epoch=storage.import_sessions.epoch,sequence=storage.import_sessions.high_water+1,operationId=operation,platformName=name,forceName='player',totalBytes=#payload,totalChunks=1}
      local r=sessions.begin(q);sessions.chunk(r.attemptId,1,payload)
      local receipt=sessions.commit(r.attemptId,function(...)
        local id,err=async.queue_import(...);assert(id,err)
        return id..'-incorrect-reply'
      end)
      assert(receipt.state=='admitting');assert(storage.async_jobs[receipt.jobId],receipt.error)
      saved[index]={attemptId=receipt.attemptId,jobId=receipt.jobId,name=name}
    end
    return {success=true,receipts=saved}`).result.receipts;
  save();
  for(const receipt of result.receipts) await lab.until(()=>lab.lua(2,`return {success=true,done=(storage.async_job_results or {})['${receipt.jobId}']~=nil}`).result.done,'admitted import job resolved');
  result.resolved=lab.lua(2,`local sessions=${module('core/import-session')};sessions.prune(true);local replies={};local copies=0
    for _,r in pairs(storage.import_sessions.records) do
      if string.find(r.operation_id,'${lab.run}:admitting-',1,true) then
        replies[#replies+1]=sessions.commit(r.id,function() error('replayed import') end)
      end
    end
    for _,p in pairs(game.forces.player.platforms) do if string.find(p.name,'${lab.run}-admitting-',1,true) then copies=copies+1 end end
    return {success=true,replies=replies,copies=copies}`).result;
  save();
  assert.equal(result.resolved.copies,4,'duplicate/missing physical platform after repeated commit');
  assert.equal(result.resolved.replies.length,4);
  assert.ok(result.resolved.replies.every(r=>r.state==='accepted'),'resolved jobs left their receipts admitting');
  result.next=lab.lua(2,`local sessions=${module('core/import-session')};local r=sessions.begin{version=1,epoch=storage.import_sessions.epoch,sequence=storage.import_sessions.high_water+1,operationId='${lab.run}:after-admitting',platformName='unused',forceName='player',totalBytes=2,totalChunks=1};sessions.abort(r.attemptId);return {success=true,state=r.state}`).result;
  assert.equal(result.next.state,'receiving');result.status='PASS';save();
  // This probe is a second protocol sender. Restart the owned instance after a
  // checkpoint so Node reconciles the advanced sequence before subsequent cases.
  const priorEpoch=lab.lua(2,'return {success=true,epoch=storage.import_sessions.epoch}').result.epoch;
  result.checkpoint=await lab.checkpoint('manual-admission-probe',[2]);
  await lab.load(2,'manual-admission-probe');
  await lab.until(()=>lab.lua(2,'return {success=true,epoch=storage.import_sessions.epoch}').result.epoch!==priorEpoch,'sender epoch reconciled');
  result.senderReconciled=true;save();
}

// Faults run only inside DockerLab's owned cluster. Teardown removes all its resources.
export async function exportNotificationFailure(lab, report, save, startQueued) {
  const name=`transfer-cleanup-${lab.run}-notification`;
  const result={name:'explicit export notification failure releases admission without importing',status:'RUNNING'};
  report.cases.push(result);save();
  result.before=lab.probe(1,'build',name).state;
  assert.deepEqual(result.before.cargo,expectedCargo);
  const api="assert(package.loaded['__level__/modules/clusterio/api.lua'])";
  lab.lua(1,`local api=${api};_G.manual_notification_send=api.send_json;api.send_json=function(channel,data) if channel=='surface_export_complete' then error('manual export notification failure') end return _G.manual_notification_send(channel,data) end;return {success=true}`);
  try {
    const accepted=startQueued(result.before.index);
    result.operationId=accepted.transferId;save();
    result.lua=await lab.until(()=>lab.lua(1,`for id,r in pairs(storage.async_job_results or {}) do if r.platform_name=='${name}' then return {success=true,result=r,jobId=id} end end return {success=true}`).result.result,'source export result');
    result.beforeObservation=summary(lab,result.operationId);save();
    result.outcome=await lab.until(()=>{const row=summary(lab,result.operationId);return row?.status==='failed'&&row;},'explicit source failure observed',45);
    assert.match(result.outcome.error,/notification/i);
    result.after=sample(lab,name);save();
    assert.equal(result.after.source.usable,true);
    assert.deepEqual(result.after.source.cargo,expectedCargo);
    assert.equal(result.after.destination.present,false);
    result.status='PASS';save();
  } finally {
    lab.lua(1,`local api=${api};api.send_json=assert(_G.manual_notification_send);_G.manual_notification_send=nil;return {success=true}`);
  }
}

export async function lostExportNotification(lab, report, save, startQueued) {
  const name=`transfer-cleanup-${lab.run}-lost-notification`;
  const result={name:'lost export notification is recovered from the same cache without replay',status:'RUNNING'};
  report.cases.push(result);save();
  result.before=lab.probe(1,'build',name).state;
  assert.deepEqual(result.before.cargo,expectedCargo);
  const api="assert(package.loaded['__level__/modules/clusterio/api.lua'])";
  // Simulate the delivery gap, not a host crash: Lua succeeds but this one notification is dropped.
  lab.lua(1,`local api=${api};_G.manual_lost_export_send=api.send_json;api.send_json=function(channel,data) if channel=='surface_export_complete' then _G.manual_lost_export_payload=data;return end return _G.manual_lost_export_send(channel,data) end;return {success=true}`);
  try {
    result.operationId=startQueued(result.before.index).transferId;save();
    result.notification=await lab.until(()=>lab.lua(1,`return {success=true,event=_G.manual_lost_export_payload}`).result.event,'suppressed export notification');
    const sourceJob=result.notification.export_id;
    result.sourceResult=lab.lua(1,`return {success=true,result=storage.async_job_results['${sourceJob}']}`).result.result;
    assert.equal(result.sourceResult.status,'complete');
    result.beforeRecovery=summary(lab,result.operationId);save();
    result.canonicalId=`${lab.ids[1]}:${sourceJob}`;
    try {
      result.outcome=await lab.until(()=>{
        const row=summary(lab,result.canonicalId)||summary(lab,result.operationId);
        result.outcome=row;
        return row?.status==='completed'&&row;
      },'stored source artifact resolves the original transfer',60);
    } catch(error) {
      result.after=sample(lab,name);result.status='STOP';save();
      throw Object.assign(error,{code:'ACCEPTANCE_STOP'});
    }
    result.after=sample(lab,name);
    assert.equal(result.after.source.present,false);
    assert.equal(result.after.destination.usable,true);
    assert.deepEqual(result.after.destination.cargo,expectedCargo);
    assert.equal(result.after.destination.canary.active,true);
    result.imports=lab.lua(2,`local count=0;for _,r in pairs(storage.import_sessions.records) do if r.platform_name=='${name}' then count=count+1 end end;return {success=true,count=count}`).result.count;
    assert.equal(result.imports,1);
    // Deliver the original push after recovery and settlement. It must not dispatch a second import.
    lab.lua(1,`local api=${api};api.send_json=assert(_G.manual_lost_export_send);api.send_json('surface_export_complete',assert(_G.manual_lost_export_payload));return {success=true}`);
    result.latePush=await lab.until(()=>{
      const script="const fs=require('fs'),p='/clusterio/logs/cluster';process.stdout.write(fs.readdirSync(p).filter(n=>n.endsWith('.log')).map(n=>fs.readFileSync(p+'/'+n,'utf8')).join(''))";
      const logs=lab.docker(['exec',lab.controller,'node','-e',script]);
      return logs.includes('Sent platform export '+sourceJob+' to controller');
    },'original completion forwarded after cache recovery');
    result.afterLatePush=sample(lab,name);
    assert.equal(result.afterLatePush.source.present,false);
    assert.deepEqual(result.afterLatePush.destination.cargo,expectedCargo);
    assert.equal(lab.lua(2,`local count=0;for _,r in pairs(storage.import_sessions.records) do if r.platform_name=='${name}' then count=count+1 end end;return {success=true,count=count}`).result.count,1);
    result.checkpoint=await lab.checkpoint('manual-export-read');
    await lab.load(2,'manual-export-read');
    result.reloaded=sample(lab,name);
    assert.deepEqual(result.reloaded.destination.cargo,expectedCargo);
    assert.equal(result.reloaded.destination.usable,true);
    result.status='PASS';save();
  } finally {
    lab.lua(1,`local api=${api};api.send_json=assert(_G.manual_lost_export_send);_G.manual_lost_export_send=nil;_G.manual_lost_export_payload=nil;return {success=true}`);
  }
}

export async function unresolvedAdmissionDiagnostics(lab, report, save) {
  const result={name:'capacity refusal identifies unresolved admissions once',status:'RUNNING'};
  report.cases.push(result);save();
  const code=`local s=assert(package.loaded['__level__/modules/surface_export/core/import-session.lua'])
    local function begin(name) return s.begin{version=1,epoch=storage.import_sessions.epoch,
      sequence=storage.import_sessions.high_water+1,operationId=name,platformName=name,forceName='player',totalBytes=2,totalChunks=1} end
    local receipts={}
    for i=1,4 do local r=begin('${lab.run}-unresolved-'..i);s.chunk(r.attemptId,1,'{}');
      receipts[i]=s.commit(r.attemptId,function() error('manual unresolved admission '..i) end) end
    for i=1,2 do local ok,err=pcall(begin,'${lab.run}-refused-'..i);assert(not ok and string.find(err,'capacity exhausted',1,true)) end
    return {success=true,receipts=receipts}`;
  result.receipts=lab.lua(2,code).result.receipts;
  assert.equal(result.receipts.length,4);
  assert.ok(result.receipts.every(r=>r.state==='admitting'));
  const rows=await lab.until(()=>{
    const matches=lab.docker(['logs',lab.hosts[2].container]).split(/\r?\n/).filter(x=>x.includes('[Upload] Capacity blocked by unresolved admission'));
    return matches.length>=4&&matches;
  },'capacity diagnostics');
  result.messages=rows;
  assert.equal(rows.length,4);
  for(const receipt of result.receipts) assert.ok(rows.some(row=>row.includes(receipt.attemptId)&&row.includes('manual unresolved admission')));
  result.status='PASS';save();
}
