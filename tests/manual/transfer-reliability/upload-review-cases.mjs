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
