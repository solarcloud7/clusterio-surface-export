-- Real scheduler, pipeline, completion and phase recorder; fake engine operations.
-- Checks callback boundaries, not Factorio's physical item/fluid behavior.
local root = "docker/seed-data/external_plugins/surface_export/module/"
local function noop() end
local function size(t) local n = 0; for _ in pairs(t or {}) do n = n + 1 end; return n end

local function scenario(options)
    local events, spans, open, scratch, cache = {}, {}, {}, 0, {}
    local env = setmetatable({game = {tick = 100, print = noop, forces = {}}, log = noop,
        storage = {async_jobs = {}, async_job_results = {}, surface_export_config = {}},
        prototypes = {entity = {beacon = {type = "beacon"}}}, table_size = size}, {__index = _G})
    local function mark(name) events[#events + 1] = {name = name, tick = env.game.tick} end
    local function start(_, name, kind)
        local s = spans[name] or {startTick = env.game.tick, callbacks = 0}
        spans[name] = s
        assert(not open[name], "measurement left running: " .. name)
        open[name] = kind or "execution"
        s.callbacks = s.callbacks + 1
    end
    local function stop(_, name)
        if not open[name] then return end
        spans[name].endTick = env.game.tick
        open[name] = nil
    end
    cache["utils/operation-timing"] = {start = start, stop = stop, fail = noop, finish = noop,
        scope = function(id, name, fn, ...)
            start(id, name); local result = fn(...); stop(id, name); return result
        end}
    local stub = setmetatable({}, {__index = function() return noop end})
    for _, name in ipairs({"utils/surface-lock", "core/import-session", "utils/export-cache",
        "core/export-pipeline", "import_phases/latch_rearm", "core/gateway-config-staging",
        "utils/util", "utils/platform-schedule", "utils/version-compat", "core/import-target",
        "utils/phase-profiler", "utils/transaction-history", "core/job-results", "core/gateway",
        "export_scanners/inventory-scanner", "export_scanners/fluid-registry",
        "export_scanners/entity-scanner", "utils/debug-export"}) do cache[name] = stub end
    cache["utils/game-utils"] = {FORCE_SYNC_PROPS = {}, ACTIVATABLE_ENTITY_TYPES = {inserter = true},
        delete_platform = function(platform) mark("discard"); platform.valid = false; return true end}
    cache["core/destination-hold"] = {
        get = function() if options.foreignHold then return {platform_index = 999, surface_index = 999} end end,
        discard = function() error("discarded a different held platform") end,
        stage = function(id, platform)
        assert(id, "transfer identity required")
        mark("hold")
        if options.holdFailure then return false, "injected hold failure" end
        platform.paused = true
        return true
    end}
    cache["core/deserializer"] = {
        create_entity = function() mark("beacon"); return {valid = true, type = "beacon"} end,
        new_item_state_session = function() scratch = scratch + 1; return {applied = 0, failed = 0, declined = 0} end,
        release_item_state_session = function() scratch = scratch - 1 end,
        restore_inventories = function(entity)
            mark("inventory")
            if options.inventoryError then error("injected inventory error") end
            -- Completion must re-disable an entity before handing control back to the game.
            entity.disabled_by_script = false
        end,
    }
    cache["import_phases/tile_restoration"] = {process = function(job)
        mark("tiles"); job.tiles_placed = true
    end}
    cache["import_phases/platform_hub_mapping"] = {
        process = function(job) mark("hub_mapping"); job.hub_mapped = true end,
        restore_hub_inventories = function() mark("hub") end,
    }
    cache["import_phases/entity_creation"] = {process_batch = function(job)
        mark("entity_batch"); job.current_index = job.current_index + 1
        return job.current_index == 2
    end}
    cache["import_phases/belt_batches"] = {plan = function()
        return {batches = {{indices = {1}, cost = 1}, {indices = {2}, cost = 1}}, cursor = 1, networks = 1}
    end}
    cache["import_phases/belt_restoration"] = {
        validate_side_groups = function() return true end,
        restore_side_groups = function()
            mark("belt_batch"); return 1, 0, options.beltFailure and 1 or 0
        end,
    }
    cache["import_phases/entity_state_restoration"] = {restore_all = function() mark("state") end}
    cache["import_phases/active_state_restoration"] = {
        service_pending_mining_progress = noop,
        restore_held_items_only = function() mark("held_items") end,
        restore = function(_, map) mark("activate"); map[1].disabled_by_script = false end,
    }
    cache["import_phases/fluid_restoration"] = {restore = function()
        mark("fluids"); return {count = 0, segment_temps = {witness = 15}}
    end}
    cache["validators/transfer-validation"] = {
        validate_import = function(_, _, opts)
            mark("validate"); assert(opts.strict and opts.segment_temps.witness == 15)
            return not options.reject, {success = not options.reject, mismatchDetails = "injected rejection"}
        end,
        store_validation_result = noop,
    }
    env.require = function(path)
        local name = path:match("^modules/surface_export/(.*)$")
        if not name then return {} end -- no event transport in this unit test
        if not cache[name] then cache[name] = assert(loadfile(root .. name .. ".lua", "t", env))() end
        return cache[name]
    end
    local job = {job_id = "test", type = "import", started_tick = 100, current_index = 0,
        platform_name = "test", total_entities = 2, metrics = {}, tiles_to_place = {},
        target_surface = {valid = true}, target_platform = {name = "test", valid = true, paused = true},
        entity_map = {[1] = {valid = true, type = "inserter", disabled_by_script = true}},
        entities_to_create = {{entity_id = 1, name = "inserter", type = "inserter"},
            {entity_id = 2, name = "beacon", type = "beacon"}},
        platform_data = {platform = {paused = true}, belt_side_groups = {{}, {}},
            verification = {item_counts = {}, fluid_counts = {}}}}
    if not options.standalone then job.transfer_id = "transfer" end
    if options.legacyWait then
        job.phase1_started, job.pending_beacon_tick = true, 103
    end
    env.storage.async_jobs.test = job
    for _ = 1, 25 do
        -- Reload module locals each tick: progress must live in the saved job table.
        for _, name in ipairs({"core/async-processor", "core/import-pipeline", "core/import-completion"}) do cache[name] = nil end
        local processor = env.require("modules/surface_export/core/async-processor")
        processor.set_show_progress(false)
        local ok, err = pcall(processor.process_tick)
        assert(scratch == 0, "scratch inventory survived the callback")
        if options.inventoryError and not ok then
            assert(tostring(err):find("injected inventory error", 1, true), tostring(err))
            assert(not job.phase2_stage and not spans.activation and not spans.fluids)
            print("PASS inventory exception releases scratch and cannot advance to activation")
            return
        end
        assert(ok, tostring(err))
        for name, kind in pairs(open) do assert(kind == "wait", "execution spans ticks: " .. name) end
        if not env.storage.async_jobs.test then break end
        assert(job.entity_map[1].disabled_by_script, "entity active between phases")
        assert(job.target_platform.paused, "platform unpaused before verdict")
        env.game.tick = env.game.tick + 1
    end
    assert(env.storage.async_jobs.test == nil, "job never finished")
    assert(not options.inventoryError, "injected exception was not reached")
    local result = env.storage.async_job_results.test
    assert(result.duration_ticks == env.game.tick - job.started_tick)
    local function eventTicks(name)
        local ticks = {}; for _, e in ipairs(events) do if e.name == name then ticks[#ticks + 1] = e.tick end end
        return ticks
    end
    if not options.legacyWait then
        local phases = {"tiles", "beacons", "entities", "hub", "belts", "state", "inventories", "held_items", "fluids"}
        for i = 2, #phases do
            assert(spans[phases[i]].startTick > spans[phases[i - 1]].endTick,
                phases[i - 1] .. " and " .. phases[i] .. " shared a tick")
        end
        assert(#eventTicks("hub") == 1 and #eventTicks("hub_mapping") == 1)
        assert(#eventTicks("state") == 1 and #eventTicks("entity_batch") == 2)
        local belts = eventTicks("belt_batch")
        assert(#belts == (options.beltFailure and 1 or 2))
        if #belts == 2 then assert(belts[2] > belts[1]) end
        assert(job.metrics.state_started_tick > job.metrics.belts_completed_tick)
    else
        assert(spans.inventories.startTick == 103 and #eventTicks("hub") == 0 and #eventTicks("belt_batch") == 0)
    end
    assert(#eventTicks("held_items") == 1 and #eventTicks("fluids") == 1)
    assert(spans.held_items.endTick < spans.fluids.startTick)
    if options.reject or options.beltFailure or options.holdFailure then
        assert(result.validation.success == false)
        if not options.holdFailure then assert(not spans.activation) end
        assert(#eventTicks("discard") == 1 and not job.target_platform.valid)
    else
        assert(spans.activation.startTick == spans.fluids.endTick)
        if not options.standalone then
            assert(result.validation.success == true and #eventTicks("hold") == 1)
            assert(eventTicks("hold")[1] == spans.activation.endTick, "activation escaped its hold callback")
        else
            assert(#eventTicks("hold") == 0, "standalone import acquired a transfer hold")
        end
    end
    if not options.standalone then assert(spans.exact_verification.startTick == spans.fluids.endTick) end
    print("PASS " .. options.label .. ": phase yields, persisted progress and final callback boundaries")
end

scenario({label = "transfer"})
scenario({label = "standalone", standalone = true})
scenario({label = "validation rejection", reject = true})
scenario({label = "belt failure", beltFailure = true})
scenario({label = "hold failure", holdFailure = true})
scenario({label = "hold identity collision", holdFailure = true, foreignHold = true})
scenario({label = "existing deferred job", legacyWait = true})
scenario({inventoryError = true})
