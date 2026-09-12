local root="docker/seed-data/external_plugins/surface_export/module/"
local decoded={one={version=1,seq=1,key="entities",first=1,values={{name="belt",lane=1}}},
  two={version=1,seq=2,key="enabled",value=false}}
local reads=0
local function noop() end
local env=setmetatable({game={tick=7,print=noop,forces={}},log=noop,
  storage={async_jobs={},async_job_results={},async_job_id_counter=0},
  helpers={decode_string=function(raw) reads=reads+1;return raw end,json_to_table=function(raw) return decoded[raw] end}}, {__index=_G})
local stub=setmetatable({},{__index=function() return noop end})
local modules={['utils/operation-timing']=setmetatable({scope=function(_,_,fn,...) return fn(...) end},{__index=function() return noop end})}
local real={['core/import-pipeline']=true,['core/import-completion']=true,['core/async-processor']=true,
  ['utils/section-codec']=true,['utils/json-compat']=true,['utils/table-utils']=true}
env.require=function(path)
  local name=path:match('^modules/surface_export/(.*)$')
  if not name then return stub end
  if not modules[name] then modules[name]=real[name] and assert(loadfile(root..name..'.lua','t',env))() or stub end
  return modules[name]
end
local pipeline=env.require('modules/surface_export/core/import-pipeline')
local envelope={section_codec=1,section_count=2,sections={'one','two'},_transferId='1:source',_sourceInstanceId=1}
local id=pipeline.queue(envelope,'test','player','RCON')
local job=env.storage.async_jobs[id]
assert(job.setup_pending and reads==0,'queue decoded payload synchronously')
env.game.tick=8;pipeline.process_setup(job)
assert(reads==1 and not job.decoded_data,'more than one frame processed')
env.game.tick=9;pipeline.process_setup(job)
assert(reads==2 and job.decoded_data.enabled==false and job.decoded_data._transferId=='1:source')
assert(job.section_decoder==nil and job.section_envelope==nil,'consumed frame state retained')
local original=pipeline.queue
local prepared=false
pipeline.queue=function(data,name,force,requester,timing,pending)
  assert(env.game.tick==10 and pending==job and pending.job_id==id and pending.started_tick==7)
  assert(data.entities[1].lane==1 and name=='test' and force=='player' and requester=='RCON')
  prepared=true;return id
end
assert(not prepared)
env.game.tick=10;pipeline.process_setup(job);assert(prepared)
pipeline.queue=original
env.storage.async_jobs={}
local bad=pipeline.queue({section_codec=1,section_count=1,sections={'missing'}},'bad','player','RCON')
local scheduler=env.require('modules/surface_export/core/async-processor')
env.game.tick=11;scheduler.process_tick()
assert(env.storage.async_jobs[bad].completion_interrupted,'decoder error left an executable job')
local failedReads=reads
env.game.tick=12;scheduler.process_tick()
assert(reads==failedReads,'failed frame replayed on the next tick')
local rejected,reason=pipeline.queue({section_codec=1,section_count=2,sections={'one'}},'bad','player','RCON')
assert(not rejected and reason:find('missing section'),'accepted missing tail')
print('PASS deferred frame decode, later preparation, routing identity and interrupted-frame replay guard')

-- Stop at the real mandatory cargo gate after decoding. Even routing metadata hidden
-- inside a compressed/sectional snapshot must lose its old source authority.
local captured
modules['utils/version-compat'] = nil -- pipeline retains its original stub; override that table below.
stub.parse = function() return {bucket='test'} end
stub.runtime_bucket = function() return 'test' end
stub.migrate = function(value) captured=value;return value end
stub.check_payload_schema = function() return true end
stub.validate_transfer_payload = function() return true end
stub.json_to_table_compat = function(raw) return decoded[raw] end
for _,codec in ipairs({'plain','compressed','sectional'}) do
  local payload={platform={schedule={}},entities={},_transferId='1:old',_sourceInstanceId=1,_operationId='old'}
  local value=payload
  if codec=='compressed' then
    decoded.legacy=payload;value={compressed=true,payload='legacy'}
  elseif codec=='sectional' then
    local frames={}
    for _,key in ipairs({'platform','entities','_transferId','_sourceInstanceId','_operationId'}) do
      local token='snapshot-'..key
      decoded[token]={version=1,seq=#frames+1,key=key,value=payload[key]};frames[#frames+1]=token
    end
    value={section_codec=1,section_count=#frames,sections=frames}
  end
  value._standaloneImport=true;value._restoreSnapshot=true;value._operationId='restore:fresh'
  local queued,err=pipeline.queue(value,'snapshot','player','RCON')
  if codec=='sectional' then
    local pending=env.storage.async_jobs[queued]
    while not pending.decoded_data do pipeline.process_setup(pending) end
    queued,err=pipeline.queue(pending.decoded_data,'snapshot','player','RCON',nil,pending)
  end
  assert(not queued and err:find('missing required verification counts',1,true),'snapshot bypassed cargo validation')
  assert(captured._transferId=='restore:fresh' and captured._operationId=='restore:fresh',codec..' retained old transfer authority')
  assert(captured._sourceInstanceId==nil and captured._standaloneImport==true,codec..' retained old source')
end
env.storage.source_recovery_ready=false
assert(pipeline.queue({},'blocked','player','RCON')==nil,'startup admitted an import before reconciliation')
print('PASS plain, compressed and sectional recovery replace routing authority and retain cargo gate')
