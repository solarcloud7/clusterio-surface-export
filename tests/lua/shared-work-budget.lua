-- Real scheduler with fake phase work: reproduces starvation by an unfinished
-- older export and checks the combined import/export callback budget.
local root = "docker/seed-data/external_plugins/surface_export/module/"
local calls={}
local function noop() end
local env=setmetatable({storage={async_jobs={},async_job_results={}},game={tick=1,print=noop},log=noop},{__index=_G})
local function mark(job) calls[#calls+1]={id=job.job_id,tick=env.game.tick} end
local stub=setmetatable({},{__index=function() return noop end})
local modules={
  ["utils/operation-timing"]={scope=function(_,_,fn,...) return fn(...) end},
  ["core/export-pipeline"]={complete=mark},
  ["core/import-pipeline"]={process_setup=mark},
  ["core/import-completion"]={run_phase2=mark},
}
env.require=function(path) return modules[path:match("^modules/surface_export/(.*)$")] or stub end
local function load() return assert(loadfile(root.."core/async-processor.lua","t",env))() end
local scheduler=load()
env.storage.async_jobs={
  a={job_id="a",type="export",started_tick=1,entities_complete=true},
  b={job_id="b",type="import",started_tick=2,setup_pending=true},
  c={job_id="c",type="export",started_tick=3,entities_complete=true},
  wait={job_id="wait",type="import",started_tick=0,pending_beacon_tick=100},
}
for tick=4,9 do env.game.tick=tick; scheduler=load();scheduler.process_tick() end
assert(#calls==6,"default must advance one combined job per callback")
for i,id in ipairs({"a","b","c","a","b","c"}) do assert(calls[i].id==id,"newer job starved or waiting job consumed slot") end
scheduler.set_max_concurrent_jobs(2)
env.game.tick=10;scheduler.process_tick()
assert(#calls==8 and calls[7].id~=calls[8].id,"combined configured limit not honored")
for _,value in ipairs({0,-1,1.5,math.huge,0/0}) do
  assert(not pcall(scheduler.set_max_concurrent_jobs,value),"accepted invalid callback budget")
end
env.game.tick=100;scheduler.process_tick()
assert(calls[9].id=="wait","ready wait never resumed")
print("PASS combined Lua step budget, import/export fairness, waiting jobs, reload and invalid limits")
