local calls, readings, profiles = 0, {}, 0
local fail = false
local original = function() calls = calls + 1; if fail then error("fixture failure") end; return 42 end
local processor = {process_tick = original}
local env = setmetatable({package = {loaded = {["__level__/modules/surface_export/core/async-processor.lua"] = processor}},
    storage = {async_jobs = {}}, game = {tick = 10},
    helpers = {create_profiler = function() profiles = profiles + 1; return {stop = function() end} end,
        table_to_json = function(meta) return meta end}, rcon = {print = function(value) readings[#readings + 1] = value end}}, {__index = _G})
local probe = assert(loadfile("tests/instruments/callback-profile/probe.lua", "t", env))()
assert(probe("arm", "transfer-cleanup-test").success)
assert(processor.process_tick() == 42 and profiles == 0, "unrelated work was profiled")
env.storage.async_jobs.test = {platform_name = "transfer-cleanup-test-baseline"}
for _ = 1, 65 do assert(processor.process_tick() == 42) end
local result = probe("disarm", "transfer-cleanup-test")
assert(result.truncated and result.records == 64 and #readings == 64)
assert(calls == 66 and processor.process_tick == original, "instrument changed execution or leaked its wrapper")
assert(probe("arm", "transfer-cleanup-test").success)
fail = true
local ok, err = pcall(processor.process_tick)
assert(not ok and err:find("fixture failure", 1, true), "instrument swallowed workload failure")
assert(probe("disarm", "transfer-cleanup-test").records == 1)
assert(processor.process_tick == original)
print("PASS callback profiler preserves work/results/errors, bounds samples and restores its wrapper")
