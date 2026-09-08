local root="__level__/modules/surface_export/"
local calls,profiles,readings=0,0,{}
local shouldFail=false
local original=function(...) calls=calls+1;if shouldFail then error("real failure") end;return 42,nil,"tail" end
local timing={scope=function(_,_,fn,...) return fn(...) end,start=function() end}
local processor,export,import={process_tick=original},{queue=original},{queue=original}
local loaded={[root.."core/async-processor.lua"]=processor,[root.."core/export-pipeline.lua"]=export,
  [root.."core/import-pipeline.lua"]=import,[root.."utils/operation-timing.lua"]=timing}
local env=setmetatable({package={loaded=loaded},storage={async_jobs={},surface_export_config={profile_batches=false}},game={tick=10},
  table_size=function(t)local n=0;for _ in pairs(t) do n=n+1 end;return n end,
  helpers={create_profiler=function()profiles=profiles+1;return {stop=function()end} end,table_to_json=function(v)return v end},
  rcon={print=function(v)readings[#readings+1]=v end}},{__index=_G})
local probe=assert(loadfile("tests/manual/transfer-reliability/performance.lua","t",env))()
local name="transfer-cleanup-se-manual-test-12345678"
local oldScope=timing.scope
assert(probe("arm",name,"off").success)
assert(timing.scope~=oldScope and timing.scope(nil,nil,function()return 15 end)==15)
processor.process_tick();assert(profiles==0,"unrelated callback profiled")
env.storage.async_jobs.job={platform_name=name}
local a,b,c=processor.process_tick();assert(a==42 and b==nil and c=="tail","return arity changed")
export.queue();import.queue()
for _=1,2001 do processor.process_tick() end
local result=probe("disarm",name,"off")
assert(result.count==2000 and result.truncated and calls==2005,"cap changed execution")
assert(readings[1][3].boundary=="scheduler" and readings[2][3].boundary=="export_setup" and readings[3][3].boundary=="import_setup")
assert(processor.process_tick==original and export.queue==original and import.queue==original and timing.scope==oldScope,"wrapper leaked")
env.storage.async_jobs={}
assert(probe("arm",name,"debug").success and env.storage.surface_export_config.profile_batches)
env.storage.async_jobs.job={platform_name=name};shouldFail=true
local ok,err=pcall(processor.process_tick);assert(not ok and err:find("real failure",1,true))
assert(probe("disarm",name,"debug").count==1 and not env.storage.surface_export_config.profile_batches)
assert(processor.process_tick==original)
print("PASS manual profiler: mode restoration, real errors, all boundaries, return arity and truncation without skipped work")
