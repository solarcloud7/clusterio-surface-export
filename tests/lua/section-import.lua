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
