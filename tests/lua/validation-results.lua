local original_require=require
function require(name)
  if name:match("^modules/surface_export/") then return {} end
  return original_require(name)
end
local validation=dofile("docker/seed-data/external_plugins/surface_export/module/validators/transfer-validation.lua")
require=original_require

local function count(t) local n=0 for _ in pairs(t or {}) do n=n+1 end return n end

storage={}
game={tick=0}
for index=1,100 do
  game.tick=index
  assert(validation.store_validation_result("transfer-"..index, {success=true, index=index}))
end
assert(count(storage.validation_results)==100)
assert(validation.get_validation_result("transfer-1").index==1, "the hundredth store keeps every result")
game.tick=101
assert(validation.store_validation_result("transfer-101", {success=false, index=101}))
assert(count(storage.validation_results)==100, "at most 100 results are stored")
assert(validation.get_validation_result("transfer-1")==nil, "the 101st store evicts the oldest result")
assert(validation.get_validation_result("transfer-2").index==2)
assert(validation.get_validation_result("transfer-101").index==101, "the newest result is retrievable")
print("PASS: the 101st stored result evicts the oldest and keeps the newest")

game.tick=102
assert(validation.store_validation_result("transfer-50", {success=true, index=150}))
assert(count(storage.validation_results)==100, "restoring an existing id does not evict another result")
assert(validation.get_validation_result("transfer-2").index==2)
assert(validation.get_validation_result("transfer-50").index==150)
print("PASS: replacing a stored result evicts nothing")

storage={validation_results={}}
for index=1,130 do
  storage.validation_results["legacy-"..index]={result={index=index}, timestamp=index}
end
storage.validation_results["same-tick-a"]={result={}, timestamp=5000}
storage.validation_results["same-tick-b"]={result={}, timestamp=5000}
storage.validation_results["no-tick"]={result={}}
game.tick=6000
assert(validation.store_validation_result("fresh", {index=0}))
assert(count(storage.validation_results)==100, "an existing save with more than 100 results is trimmed on the next store")
assert(validation.get_validation_result("fresh").index==0)
assert(validation.get_validation_result("same-tick-a") and validation.get_validation_result("same-tick-b"))
assert(validation.get_validation_result("no-tick")==nil, "a result without a tick is the oldest")
for index=1,33 do
  assert(storage.validation_results["legacy-"..index]==nil, "legacy-"..index.." is among the oldest")
end
for index=34,130 do
  assert(storage.validation_results["legacy-"..index], "legacy-"..index.." is among the newest")
end
print("PASS: an oversized save is trimmed to the newest 100 by stored tick")

storage={validation_results={}}
for index=1,99 do
  storage.validation_results["old-"..index]={result={}, timestamp=1}
end
storage.validation_results["tie-a"]={result={}, timestamp=1}
storage.validation_results["tie-b"]={result={}, timestamp=1}
game.tick=2
assert(validation.store_validation_result("newest", {}))
assert(count(storage.validation_results)==100)
local evicted={}
for _, id in ipairs({"old-1", "old-10", "old-11"}) do
  if storage.validation_results[id]==nil then evicted[#evicted+1]=id end
end
assert(#evicted==2 and evicted[1]=="old-1" and evicted[2]=="old-10", "equal ticks evict the lowest ids first")
print("PASS: results stored on the same tick are evicted in id order")
