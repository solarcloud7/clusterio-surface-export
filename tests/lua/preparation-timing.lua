-- Execute the real queue functions. Fake engine failures must keep their original
-- return/cleanup behavior while marking the responsible preparation measurement.
local root = "docker/seed-data/external_plugins/surface_export/module/"
local function noop() end
local function scenario(side, fault)
    local spans, calls, deleted = {}, {}, false
    local function called(name) calls[#calls + 1] = name end
    local timing = {begin = noop, bind = noop, start = function(_, name, kind, parent)
        assert(not spans[name], "repeated span " .. name)
        spans[name] = {parent = parent, running = true}
    end, stop = function(_, name) assert(spans[name], name); spans[name].running = false end,
    fail = function(_, name) spans[name].failed = true end,
    finish = function() for _, span in pairs(spans) do span.running = false end end}
    timing.scope = function(id, name, fn, ...)
        timing.start(id, name); local result = table.pack(fn(...)); timing.stop(id, name)
        return table.unpack(result, 1, result.n)
    end
    local force = {valid = true, name = "player", platforms = {}}
    local hub = {valid = true, name = "space-platform-hub", position = {x = 0, y = 0},
        get_inventory = function() return {clear = function() called("clear") end} end}
    local entities = {hub}
    local surface = {valid = true, find_entities_filtered = function() called("collect"); return entities end}
    local platform = {valid = true, index = 3, name = "fixture", surface = surface, hub = hub}
    force.platforms[3] = platform
    force.create_space_platform = function(opts)
        called("create"); assert(opts.name == "destination" and opts.starter_pack == "space-platform-starter-pack")
        if fault == "platform_creation" then error("injected creation") end
        return {valid = true, index = 4, name = opts.name, hub = hub, surface = surface,
            apply_starter_pack = function() called("starter"); if fault == "starter_pack" then error("injected starter") end end}
    end
    local schedule = {records = {}}
    local modules = {
        ["utils/operation-timing"] = timing,
        ["utils/game-utils"] = {platform_has_hub = function() return true end,
            delete_platform = function() called("delete"); deleted = true end},
        ["utils/surface-lock"] = {DEFAULT_TRANSFER_LOCK_TTL_TICKS = 36000,
            lock_platform = function() called("lock"); return true end,
            unlock_platform = function() called("unlock"); return true end},
        ["utils/platform-schedule"] = {
            capture = function() called("capture"); if fault == "schedule_capture" then return nil, "capture refused" end; return schedule end,
            summarize = function() return {record_count = 0, interrupt_count = 0} end,
            validate_transfer_payload = function() return true end,
            filter_for_import = function(value) return value end,
            apply = function(_, value) called("schedule"); assert(value == schedule); return fault ~= "schedule_restoration", "schedule refused" end},
        ["export_scanners/fluid-registry"] = {new = function() return {} end},
        ["export_scanners/source-cargo-integrity"] = {new = function() return {} end},
        ["export_scanners/tile_scanner"] = {scan_surface = function(value) called("tiles"); assert(value == surface); return {} end},
        ["utils/util"] = {format_timestamp = noop, sum_items = function() return 0 end, sum_fluids = function() return 0 end},
        ["utils/version-compat"] = {PAYLOAD_SCHEMA_VERSION = 1, parse = function() return {bucket = "2.1"} end,
            runtime_bucket = function() return "2.1" end, migrate = function(value) return value end,
            check_payload_schema = function() return true end},
        ["core/import-target"] = {resolve = function() return "nauvis" end},
    }
    local stub = setmetatable({}, {__index = function() return noop end})
    local env = setmetatable({storage = {async_job_id_counter = 0, async_jobs = {}}, log = noop,
        game = {tick = 100, print = noop, forces = {player = force}}, script = {active_mods = {base = "2.1.17"}},
        defines = {inventory = {hub_main = 1}}, require = function(path)
            return modules[path:match("^modules/surface_export/(.*)$")] or stub
        end}, {__index = _G})
    local pipeline = assert(loadfile(root .. "core/" .. side .. "-pipeline.lua", "t", env))()
    local id, err
    if side == "export" then id, err = pipeline.queue(3, "player", "test", 2)
    else id, err = pipeline.queue({_transferId = "operation", platform = {schedule = schedule},
        verification = {item_counts = {}, fluid_counts = {}}, entities = {}}, "destination", "player", "test") end
    if fault then
        assert(not id and err, "fault became queued success")
        assert(spans[fault].failed and not spans[fault].running, "failed child not closed")
        assert(next(env.storage.async_jobs) == nil)
        assert(deleted == (side == "import" and fault ~= "platform_creation"))
    else
        assert(id and env.storage.async_jobs[id])
        local names = side == "export"
            and {"schedule_capture", "entity_collection", "entity_sorting", "tile_scan", "export_job_setup"}
            or {"platform_naming", "target_resolution", "platform_creation", "starter_pack", "starter_cleanup", "platform_parking", "schedule_restoration", "import_cargo_totals"}
        for _, name in ipairs(names) do
            assert(spans[name] and not spans[name].running and not spans[name].failed, name)
            assert(spans[name].parent == (side == "export" and "preparation" or "platform_preparation"))
        end
        assert(table.concat(calls, ",") == (side == "export" and "lock,capture,collect,tiles" or "create,starter,clear,collect,schedule"))
    end
end
scenario("export")
scenario("import")
scenario("export", "schedule_capture")
for _, stage in ipairs({"platform_creation", "starter_pack", "schedule_restoration"}) do scenario("import", stage) end
print("PASS preparation spans, parent clocks, engine call order and handled-failure cleanup")
