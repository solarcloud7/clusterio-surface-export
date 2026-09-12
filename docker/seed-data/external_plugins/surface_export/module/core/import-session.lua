local Timing = require("modules/surface_export/utils/operation-timing")
local Sessions = {VERSION = 1, MAX_SESSIONS = 4, MAX_BYTES = 512 * 1024 * 1024,
 MAX_BUFFERED_BYTES = 1024 * 1024 * 1024, MAX_CHUNK_BYTES = 100000, MAX_RECEIPTS = 512}
local function integer(v, max) return type(v) == "number" and v >= 1 and v % 1 == 0 and v <= max end
local function store()
 local s = storage.import_sessions
 assert(s and s.version == Sessions.VERSION, "Upload protocol is not initialized")
 return s
end
local function reply(r)
 return {version=Sessions.VERSION, success=true, attemptId=r.id, operationId=r.operation_id,
  epoch=r.epoch, state=r.state, jobId=r.job_id, error=r.error,
  receivedChunks=r.received_count, receivedBytes=r.received_bytes}
end
local function release(r, state, reason)
 r.chunks=nil; r.state, r.error=state, reason
 Timing.finish(r.timing_id, state == "accepted" and "completed" or "interrupted")
end
local function reconcile(r)
 if r.state~="admitting" then return end
 local evidence=(storage.async_jobs or {})[r.job_id] or (storage.async_job_results or {})[r.job_id]
 if evidence and (evidence.operation_id==r.operation_id or evidence.transfer_id==r.operation_id) then
  release(r,"accepted",r.error)
 end
end
function Sessions.initialize(epoch)
 assert(type(epoch)=="string" and epoch~="" and epoch==storage.source_recovery_epoch,
  "Upload sender must match the reconciled runtime epoch")
 local old=storage.import_sessions
 if not old or old.version~=Sessions.VERSION then
  local retired=0
  for _ in pairs(old or {}) do retired=retired+1 end
  for _ in pairs(storage.chunked_imports or {}) do retired=retired+1 end
  storage.import_sessions={version=Sessions.VERSION, epoch=epoch, high_water=0, records={}}
  storage.chunked_imports=nil
  if retired>0 then log("[Upload] Retired "..retired.." legacy incomplete buffers; platform jobs were preserved") end
 elseif old.epoch~=epoch then
  for _,r in pairs(old.records) do
   if r.state=="receiving" then release(r,"aborted","Sender runtime ended") end
  end
  old.epoch,old.high_water=epoch,0
 end
 Sessions.prune(true)
 return {version=Sessions.VERSION,success=true,epoch=epoch,highWater=storage.import_sessions.high_water,
  limits={chunkBytes=Sessions.MAX_CHUNK_BYTES,maxUploadBytes=Sessions.MAX_BYTES,
   maxBufferedBytes=Sessions.MAX_BUFFERED_BYTES,maxSessions=Sessions.MAX_SESSIONS}}
end
function Sessions.begin(q)
 local s=store()
 assert(q.version==Sessions.VERSION,"Unsupported upload protocol")
 assert(q.epoch==s.epoch and q.epoch==storage.source_recovery_epoch,"Upload sender epoch changed")
 assert(type(q.operationId)=="string" and #q.operationId>0 and #q.operationId<=512,"Invalid operation identity")
 assert(integer(q.sequence,9007199254740991),"Invalid upload sequence")
 assert(type(q.platformName)=="string" and #q.platformName>0 and #q.platformName<=1024,"Invalid platform name")
 assert(type(q.forceName)=="string" and #q.forceName>0 and #q.forceName<=1024,"Invalid force name")
 assert(integer(q.totalBytes,Sessions.MAX_BYTES),"Upload exceeds encoded byte limit")
 assert(integer(q.totalChunks,math.ceil(Sessions.MAX_BYTES/Sessions.MAX_CHUNK_BYTES))
  and q.totalChunks==math.ceil(q.totalBytes/Sessions.MAX_CHUNK_BYTES),"Invalid chunk count")
 local id=q.epoch..":"..tostring(q.sequence)
 local r=s.records[id]
 if r then
  assert(r.operation_id==q.operationId and r.platform_name==q.platformName and r.force_name==q.forceName
   and r.total_bytes==q.totalBytes and r.total_chunks==q.totalChunks,"Upload metadata changed")
  return reply(r)
 end
 assert(q.sequence>s.high_water,"Upload attempt is no longer available")
 -- Begin calls are serialized by the sender. A closed sequence cannot be reused,
 -- even after the small result receipt has been pruned.
 s.high_water=q.sequence
 local count,bytes=0,0
 for _,other in pairs(s.records) do
  reconcile(other)
  if other.operation_id==q.operationId then
   assert(other.platform_name==q.platformName and other.force_name==q.forceName
    and other.total_bytes==q.totalBytes and other.total_chunks==q.totalChunks,"Upload metadata changed")
   return reply(other)
  end
  if other.chunks or other.state=="admitting" then count=count+1 end
  if other.chunks then bytes=bytes+other.total_bytes end
 end
 if count>=Sessions.MAX_SESSIONS or bytes+q.totalBytes>Sessions.MAX_BUFFERED_BYTES then
  for _,other in pairs(s.records) do
   if other.state=="admitting" and not other.capacity_reported then
    other.capacity_reported=true
    local reason=tostring(other.error or "No matching job evidence"):gsub("[\r\n]"," "):sub(1,2048)
    log("[Upload] Capacity blocked by unresolved admission "..other.id..": "..reason)
   end
  end
  error("Upload capacity exhausted")
 end
 r={id=id,epoch=q.epoch,operation_id=q.operationId,state="receiving",platform_name=q.platformName,
  force_name=q.forceName,total_bytes=q.totalBytes,total_chunks=q.totalChunks,chunks={},received_count=0,
  received_bytes=0,started_tick=game.tick,last_progress_tick=game.tick,timing_id="upload:"..id}
 s.records[id]=r
 Timing.begin(r.timing_id,"destination-lua",r.operation_id)
 Timing.start(r.timing_id,"chunk_delivery","inclusive")
 Sessions.prune()
 return reply(r)
end
local function find(id)
 assert(type(id)=="string","Invalid upload attempt")
 local r=store().records[id]
 assert(r,"Upload attempt is no longer available")
 return r
end
function Sessions.chunk(id,index,data)
 local r=find(id)
 assert(r.state=="receiving" and r.epoch==store().epoch,"Upload is closed")
 assert(integer(index,r.total_chunks) and type(data)=="string","Invalid chunk")
 local expected=index<r.total_chunks and Sessions.MAX_CHUNK_BYTES
  or r.total_bytes-(r.total_chunks-1)*Sessions.MAX_CHUNK_BYTES
 assert(#data==expected,"Chunk byte count differs from declared upload")
 if r.chunks[index] then
  assert(r.chunks[index]==data,"Conflicting duplicate chunk")
  return reply(r)
 end
 r.chunks[index]=data
 r.received_count,r.received_bytes=r.received_count+1,r.received_bytes+#data
 r.last_progress_tick=game.tick
 return reply(r)
end
function Sessions.commit(id,queue)
 local r=find(id)
 reconcile(r)
 if r.state~="receiving" then return reply(r) end
 assert(r.epoch==store().epoch,"Upload sender epoch changed")
 assert(r.received_count==r.total_chunks and r.received_bytes==r.total_bytes,"Upload is incomplete")
 storage.async_job_id_counter=(storage.async_job_id_counter or 0)+1
 r.job_id="import_"..storage.async_job_id_counter
 r.state="admitting"
 -- Persist ownership before anything that can allocate a platform or throw.
 local ok,job_id,err=pcall(function()
  local json=Timing.scope(r.timing_id,"chunk_assembly",table.concat,r.chunks,"")
  return queue(json,r.platform_name,r.force_name,"RCON_CHUNKED",{import_job_id=r.job_id,
   operation_id=r.operation_id,delivery_started_tick=r.started_tick,delivery_completed_tick=game.tick})
 end)
 if ok and job_id then
  if job_id==r.job_id then release(r,"accepted")
  else release(r,"admitting","Import admission changed reserved job identity") end
 elseif (storage.async_jobs or {})[r.job_id] or (storage.async_job_results or {})[r.job_id] then
  release(r,"accepted",tostring(ok and err or job_id))
 elseif ok then release(r,"rejected",tostring(err or "Import rejected before job creation"))
 else
  -- Missing job evidence after an exception does not prove there were no side effects.
  release(r,"admitting",tostring(job_id))
 end
 return reply(r)
end
function Sessions.status(id)
 local r=store().records[id]
 if r then reconcile(r) end
 return r and reply(r) or {version=Sessions.VERSION,success=true,state="unavailable"}
end
function Sessions.abort(id)
 local r=store().records[id]
 if not r then return Sessions.status(id) end
 if r.state=="receiving" then release(r,"aborted","Sender ended upload") end
 return reply(r)
end
function Sessions.prune(force)
 local s=storage.import_sessions
 if not s or s.version~=Sessions.VERSION then return end
 if not force and s.next_prune_tick and game.tick<s.next_prune_tick then return end
 s.next_prune_tick=game.tick+300
 local closed={}
 for id,r in pairs(s.records) do
  reconcile(r)
  if r.state~="receiving" and r.state~="admitting" and not (storage.async_jobs or {})[r.job_id] then
   closed[#closed+1]=id
  end
 end
 table.sort(closed,function(a,b)
  local first,second=s.records[a],s.records[b]
  if first.started_tick~=second.started_tick then return first.started_tick<second.started_tick end
  return a<b
 end)
 for i=1,#closed-Sessions.MAX_RECEIPTS do s.records[closed[i]]=nil end
end
return Sessions
