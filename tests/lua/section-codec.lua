local root = "docker/seed-data/external_plugins/surface_export/module/"
local modules, decoded = {}, {}
local env = setmetatable({log=function() end}, {__index=_G})
env.require = function(path)
  local name = path:match("^modules/surface_export/(.*)$")
  if not modules[name] then modules[name]=assert(loadfile(root..name..".lua","t",env))() end
  return modules[name]
end
env.helpers = {json_to_table=function(text) return decoded[text] end}
local json = env.require("modules/surface_export/utils/json-compat")
local function codec()
  modules["utils/section-codec"]=nil
  return env.require("modules/surface_export/utils/section-codec")
end
local input = {entities={},tiles={},belt_side_groups={},enabled=false,label='quote" line\n',empty={}}
for i=1,25 do input.entities[i]={id=i,quality="rare",inventory={{name="iron-plate",count=i}}} end
local function run(data)
  local job,result={export_data=data}
  for tick=1,100 do result=codec().encode_step(job,5); if result then return result,tick end end
  error("encoder did not finish")
end
local result,ticks=run(input)
assert(result.frames and ticks>25, "did not yield between records")
local keys,expected={},{}
for key in pairs(input) do keys[#keys+1]=key end;table.sort(keys)
for _,key in ipairs(keys) do expected[#expected+1]=json.to_json(key)..":"..json.to_json(input[key]) end
assert(result.json=="{"..table.concat(expected,",").."}", "document changed")
local huge=run({entities={{inventory=string.rep("x",70000)}}})
assert(not huge.frames and huge.fallback and #huge.json>70000,"oversized record must preserve legacy data")

local frames={
  {version=1,seq=1,key="entities",first=1,values={{name="belt",lane=1}}},
  {version=1,seq=2,key="entities",first=2,values={{name="belt",lane=2}}},
  {version=1,seq=3,key="enabled",value=false},
}
for i,frame in ipairs(frames) do decoded[tostring(i)]=frame end
local state=codec().new_decoder(3)
assert(codec().decode_step(state,"1")==nil)
assert(codec().decode_step(state,"2")==nil)
local output=codec().decode_step(state,"3")
assert(output.enabled==false and #output.entities==2 and output.entities[2].lane==2)
assert(not pcall(codec().decode_step,state,"3"),"accepted replay after completion")
assert(not pcall(codec().decode_step,codec().new_decoder(3),"2"),"accepted missing prefix")
decoded.bad={version=1,seq=1,key="entities",first=2,values={{}}}
assert(not pcall(codec().decode_step,codec().new_decoder(1),"bad"),"accepted wrong offset")
decoded.bad={version=1,seq=1,key="x"}
assert(not pcall(codec().decode_step,codec().new_decoder(1),"bad"),"accepted missing value")
decoded.bad={version=1,seq=1,key="entities",first=1,values={"not a record"}}
assert(not pcall(codec().decode_step,codec().new_decoder(1),"bad"),"accepted invalid record")
print("PASS section encoder parity, persisted steps, legacy fallback, decoder ordering and invalid records")
