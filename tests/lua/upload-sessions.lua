local root = "docker/seed-data/external_plugins/surface_export/module/"
local original_require = require
function require(name)
  if name == "modules/surface_export/utils/operation-timing" then
    return {begin=function() end,start=function() end,finish=function() end,
      scope=function(_,_,fn,...) return fn(...) end}
  end
  return original_require(name)
end
storage = {source_recovery_epoch="epoch",async_jobs={}}
game = {tick=1}
local diagnostics = {}
function log(s) diagnostics[#diagnostics+1]=s end
local sessions = dofile(root.."core/import-session.lua")
local function fails(fn, text)
  local ok,err=pcall(fn); assert(not ok and tostring(err):find(text,1,true),tostring(err))
end
local sequence=0
local function begin(size, operation)
  sequence=sequence+1
  return sessions.begin({version=1,epoch=storage.source_recovery_epoch,sequence=sequence,
    operationId=operation or "op"..sequence,platformName="same name",forceName="player",
    totalBytes=size or 2,totalChunks=math.ceil((size or 2)/100000)})
end
sessions.initialize("epoch")
local a=begin(); local b=begin()
sessions.chunk(a.attemptId,1,"{}")
game.tick=50000
sessions.chunk(a.attemptId,1,"{}")
assert(storage.import_sessions.records[a.attemptId].last_progress_tick==1,"duplicate is not progress")
fails(function() sessions.chunk(a.attemptId,1,"[]") end,"Conflicting")
local calls=0
local function queue(_,_,_,_,timing)
  calls=calls+1
  assert(storage.import_sessions.records[a.attemptId].state=="admitting","reserve before preparation")
  storage.async_jobs[timing.import_job_id]={job_id=timing.import_job_id}
  return timing.import_job_id
end
local accepted=sessions.commit(a.attemptId,queue)
assert(accepted.state=="accepted" and accepted.jobId and calls==1)
assert(not storage.import_sessions.records[a.attemptId].chunks)
assert(sessions.commit(a.attemptId,queue).jobId==accepted.jobId and calls==1,"lost reply replay")
assert(sessions.abort(a.attemptId).state=="accepted","cleanup cannot abort a job")
fails(function() sessions.chunk(a.attemptId,1,"{}") end,"closed")
assert(sessions.abort(b.attemptId).state=="aborted")
assert(sessions.status("missing").state=="unavailable")
fails(function() sessions.commit("missing",queue) end,"no longer available")

local throws=begin(); sessions.chunk(throws.attemptId,1,"{}")
local uncertain=sessions.commit(throws.attemptId,function() error("unknown setup effects") end)
assert(uncertain.state=="admitting" and not storage.import_sessions.records[throws.attemptId].chunks)
assert(sessions.abort(throws.attemptId).state=="admitting")
local protected=begin(); sessions.chunk(protected.attemptId,1,"{}")
local retained=sessions.commit(protected.attemptId,function(_,_,_,_,timing)
  storage.async_jobs[timing.import_job_id]={setup_cleanup={}}
  error("cleanup pending")
end)
assert(retained.state=="accepted" and storage.async_jobs[retained.jobId].setup_cleanup)

local incomplete=begin()
storage.source_recovery_epoch="next"
sessions=dofile(root.."core/import-session.lua") -- saved tables survive module reload
sessions.initialize("next")
assert(sessions.status(incomplete.attemptId).state=="aborted")
assert(sessions.status(a.attemptId).jobId==accepted.jobId)
assert(sessions.status(throws.attemptId).state=="admitting")
assert(storage.async_jobs[retained.jobId].setup_cleanup)

storage={source_recovery_epoch="bounds"}; sessions.initialize("bounds"); sequence=0
for _=1,4 do begin() end
fails(function() begin() end,"capacity exhausted")
for id in pairs(storage.import_sessions.records) do sessions.abort(id) end
begin(512*1024*1024); begin(512*1024*1024)
fails(function() begin() end,"capacity exhausted")
fails(function() begin(512*1024*1024+1) end,"encoded byte limit")

storage={source_recovery_epoch="legacy",chunked_imports={old={chunks={"payload"}}},
  import_sessions={other={}},async_jobs={keep={}},validation_results={keep={}},locked_platforms={keep={}}}
sessions.initialize("legacy"); sessions.initialize("legacy")
assert(#diagnostics==1 and not storage.chunked_imports)
assert(storage.async_jobs.keep and storage.validation_results.keep and storage.locked_platforms.keep)
storage={source_recovery_epoch="prune",async_jobs={}};sessions.initialize("prune");sequence=0
local expired=begin();sessions.chunk(expired.attemptId,1,"{}")
local admissions=0
sessions.commit(expired.attemptId,function(_,_,_,_,timing) admissions=admissions+1;return timing.import_job_id end)
for _=1,sessions.MAX_RECEIPTS+1 do local r=begin();sessions.abort(r.attemptId);game.tick=game.tick+1 end
sessions.prune(true)
assert(sessions.status(expired.attemptId).state=="unavailable")
fails(function() sessions.commit(expired.attemptId,function() admissions=admissions+1 end) end,"no longer available")
fails(function() sessions.chunk(expired.attemptId,1,"{}") end,"no longer available")
assert(admissions==1,"expired receipt replay admitted another job")
print("PASS: upload ownership, duplicate commit, capacity, cleanup uncertainty, receipt expiry and reload")

storage={source_recovery_epoch="admitting",async_jobs={},async_job_results={}}
sessions.initialize("admitting");sequence=0
local unresolved={}
for index=1,4 do
  local receipt=begin(2,"uncertain"..index);sessions.chunk(receipt.attemptId,1,"{}")
  unresolved[index]=sessions.commit(receipt.attemptId,function() error("uncertain admission") end)
end
fails(function() begin() end,"capacity exhausted")
for _,receipt in ipairs(unresolved) do
  storage.async_job_results[receipt.jobId]={status="complete",operation_id="foreign-operation"}
end
sessions.prune(true)
fails(function() begin() end,"capacity exhausted")
for index,receipt in ipairs(unresolved) do
  storage.async_job_results[receipt.jobId]={status="complete",operation_id="uncertain"..index}
end
sessions.prune(true)
assert(begin().state=="receiving","resolved admission must return staging capacity")
for _,receipt in ipairs(unresolved) do
  assert(sessions.commit(receipt.attemptId,function() error("must not replay") end).state=="accepted")
end
print("PASS: late job evidence resolves admitting receipts without another import")
