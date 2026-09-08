-- Real scheduler, completion pipeline and diagnostic writer, with mocked engine operations.
local root = "docker/seed-data/external_plugins/surface_export/module/"
local function noop() end
local function size(t) local n = 0; for _ in pairs(t or {}) do n = n + 1 end; return n end
local function scenario(standalone, encode_failure)
local events, writes, modules, encodes = {}, {}, {}, 0
local env = setmetatable({game = {tick = 100, print = noop, forces = {player = {valid = true, platforms = {}}}},
    storage = {async_jobs = {}, async_job_results = {}, surface_export_config = {debug_mode = true}},
    log = noop, table_size = size}, {__index = _G})
local function mark(name) assert(not events[name], "repeated step: " .. name); events[name] = env.game.tick end
local stub = setmetatable({}, {__index = function() return noop end})
for _, name in ipairs({"utils/surface-lock", "core/import-session", "core/import-pipeline",
    "core/import-completion", "import_phases/active_state_restoration", "import_phases/latch_rearm",
    "core/gateway-config-staging", "utils/phase-profiler", "utils/transaction-history", "core/job-results",
    "utils/version-compat", "export_scanners/entity-handlers", "export_scanners/tile_scanner",
    "export_scanners/blueprint-diff", "import_phases/belt_restoration"}) do modules[name] = stub end
modules["utils/operation-timing"] = {start = noop, stop = noop, finish = noop,
    scope = function(_, stage, fn, ...) mark(stage); return fn(...) end}
modules["utils/game-utils"] = {FORCE_SYNC_PROPS = {}, pcall_warn = function(_, fn) return pcall(fn) end}
modules["utils/surface-lock"] = {unlock_platform = function() mark("unlock"); return true end}
modules["utils/export-cache"] = {set_concurrency = noop, prune_to_configured_cap = noop,
    record = function(_, data) mark("cache"); assert(data.payload == "compressed") end}
modules["utils/platform-schedule"] = {summarize = function() return {} end}
modules["export_scanners/entity-scanner"] = {scan_items_on_ground = function() return {} end}
modules["export_scanners/inventory-scanner"] = {extract_belt_items = function() mark("belt_read"); return {} end}
modules["export_scanners/fluid-registry"] = {list = function() return {} end}
modules["export_scanners/source-cargo-integrity"] = {record = noop, verdict = function() return {ok = true} end}
modules["validators/verification"] = {count_all_items = function() mark("verify"); return {} end,
    count_fluid_segments = function() return {} end}
local payload = {entities = {{entity_id = 1}}, tiles = {}, platform_name = "fixture"}
modules["utils/util"] = {
    encode_json_compat = function(data)
        if data == payload then
            assert(not encode_failure, "injected serialization failure")
            encodes = encodes + 1; return '{"captured":true}'
        end
        return '{}'
    end,
    write_file_compat = function(name, data) writes[name] = data; return true end,
}
env.helpers = {encode_string = function(data) assert(data == '{"captured":true}'); return "compressed" end}
env.require = function(path)
    if path == "modules/clusterio/api" then return {send_json = function(channel) mark(channel) end} end
    local name = assert(path:match("^modules/surface_export/(.*)$"))
    if not modules[name] then modules[name] = assert(loadfile(root .. name .. ".lua", "t", env))() end
    return modules[name]
end
local pipeline = env.require("modules/surface_export/core/export-pipeline")
pipeline.process_batch = function() return true end -- entity engine operations are covered separately
local scheduler = env.require("modules/surface_export/core/async-processor")
local job = {job_id = "test", type = "export", started_tick = 100, current_index = 1, total_entities = 1,
    platform_index = 3, platform_name = "fixture", force_name = "player", destination_instance_id = 2,
    export_data = payload, belt_entities = {[1] = {valid = true}}, surface = {valid = true}, census = {}}
env.storage.async_jobs.test = job
if standalone then job.destination_instance_id = nil end
for tick = 100, 103 do
    env.game.tick = tick
    if encode_failure and tick == 102 then
        local ok, err = pcall(scheduler.process_tick)
        assert(not ok and tostring(err):find("injected serialization failure", 1, true))
        assert(env.storage.async_jobs.test and not events.cache and not events.unlock)
        assert(not events.surface_export_complete, "failed serialization published success")
        return
    end
    scheduler.process_tick()
    if tick < 103 then assert(env.storage.async_jobs.test, "publication finished too early") end
end
assert(events.entities == 100 and events.belt_read == 101 and events.verify == 101)
assert(events.serialization == 102 and events.compression == 103 and events.surface_export_complete == 103)
assert(encodes == 1, "diagnostic output serialized the payload again")
if standalone then
    assert(events.unlock == 103, "standalone export unlocked before publication")
else
    assert(not events.unlock, "transfer export released its source")
    assert(writes["debug_source_platform_fixture_103.json"] == '{"captured":true}', "diagnostic bytes differ from transport JSON")
end
assert(not env.storage.async_jobs.test and env.storage.async_job_results.test.complete)
end
scenario(false, false)
scenario(true, false)
scenario(false, true)
print("PASS transfer/standalone export yields, atomic capture/checks, serialization reuse and failed-encode gate")
