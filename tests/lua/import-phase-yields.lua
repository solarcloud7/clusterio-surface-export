-- Real scheduler, pipeline, completion and phase recorder; fake engine operations.
-- Checks callback boundaries, not Factorio's physical item/fluid behavior.
local root = "docker/seed-data/external_plugins/surface_export/module/"
local function noop() end
local function size(t) local n = 0; for _ in pairs(t or {}) do n = n + 1 end; return n end

local function scenario(options)
    local events, spans, open, scratch, cache = {}, {}, {}, 0, {}
    local env = setmetatable({game = {tick = 100, print = function() error("import phases must not broadcast chat") end, forces = {}}, log = noop,
        script = {active_mods = {}},
        storage = {async_jobs = {}, async_job_results = {}, surface_export_config = {
            debug_mode = options.debug, preserve_failed_destination = options.preserve}},
        prototypes = {entity = {beacon = {type = "beacon"}}}, table_size = size}, {__index = _G})
    local function mark(name)
        events[#events + 1] = {name = name, tick = env.game.tick}
        if options.errorAt == name then error("injected " .. name .. " error") end
    end
    local function start(_, name, kind)
        local s = spans[name] or {startTick = env.game.tick, callbacks = 0}
        spans[name] = s
        -- Real Timing.start returns when a stage is already running. Throwing here
        -- would accidentally prevent the very replay this regression must detect.
        if open[name] then return end
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
        "utils/phase-profiler", "utils/transaction-history",
        "export_scanners/inventory-scanner", "export_scanners/fluid-registry",
        "export_scanners/entity-scanner"}) do cache[name] = stub end
    cache["utils/debug-export"] = {destination_snapshot_enabled = function() return false end,
        write_failure_black_box = function()
            mark("black_box")
            if options.blackBoxFailure then error("injected diagnostic error") end
            return "failure.json"
        end}
    cache["core/gateway"] = {evacuate_passengers = function()
        if options.evacuation == "throw" then error("injected evacuation error") end
        if options.evacuation == "missing" then return nil end
        return {success = not options.evacuation, failures = options.evacuation and 1 or 0}
    end}
    cache["utils/game-utils"] = {FORCE_SYNC_PROPS = {}, ACTIVATABLE_ENTITY_TYPES = {inserter = true, beacon = true},
        delete_platform = function(platform) mark("discard"); platform.valid = false; return true end}
    cache["core/destination-hold"] = {
		go_live = function() mark("release"); return true end,
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
            if options.largeInventory and entity.type ~= "beacon" then
                assert(not env.storage.async_jobs.test.entity_map[2].disabled_by_script,
                    "beacon disabled before dependent inventory capacity was restored")
            end
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
        attribute_lines = function() return {} end,
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
        if options.largeInventory then
            assert(env.storage.async_jobs.test.entity_map[2].disabled_by_script,
                "beacon still active after inventory restoration")
        end
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
        if not name then
            return {send_json = function(name, payload)
                assert(name == "surface_export_import_complete")
                mark("publish")
                assert(payload.success == (payload.validation and payload.validation.success == true))
            end}
        end
        if not cache[name] then cache[name] = assert(loadfile(root .. name .. ".lua", "t", env))() end
        return cache[name]
    end
    local job = {job_id = "test", type = "import", started_tick = 100, current_index = 0,
        platform_name = "test", total_entities = 2, metrics = {}, tiles_to_place = {},
        target_surface = {valid = true}, target_platform = {name = "test", valid = true, paused = true},
        entity_map = {[1] = {valid = true, type = "inserter", disabled_by_script = true}},
        entities_to_create = {{entity_id = 1, name = "inserter", type = "inserter"},
            {entity_id = 2, name = "beacon", type = "beacon"}},
        platform_data = {_standaloneImport = options.snapshot, platform = {paused = true}, belt_side_groups = {{}, {}},
            verification = {item_counts = {}, fluid_counts = {}}}}
    if options.evacuation then
        cache["core/destination-hold"] = nil
        cache["utils/platform-identity"] = function() return "destination-uid" end
        cache["utils/surface-lock"] = {complete_cargo_pods = function()
            if options.partialQuarantine then error("injected partial hold failure") end
            return 0, 0, 0
        end}
        job.target_surface.index = 8
        job.target_surface.find_entities_filtered = function(filter)
            if filter.name then return {} end
            return {job.entity_map[1]}
        end
        job.target_platform.index, job.target_platform.surface = 3, job.target_surface
        env.game.forces.player = {valid=true, name="player", platforms={[3]=job.target_platform},
            get_surface_hidden=function() return false end, set_surface_hidden=function()
                if options.quarantineFailure then error("injected quarantine failure") end
            end}
        job.target_platform.force = env.game.forces.player
        job.entity_map[1].unit_number, job.entity_map[1].active = 1, true
    end
    if not options.standalone then job.transfer_id = "transfer" end
    if options.identity then
        job.force_name = "player"
        job.target_surface.index = 8
        job.target_platform.index, job.target_platform.surface = 3, job.target_surface
        job.target_platform.hub = {valid = true, unit_number = 401}
        env.storage.source_recovery_surface_epochs = {[8] = "fixture-epoch"}
    end
    if options.largeInventory then
        for _, ed in ipairs(job.entities_to_create) do
            local items = {}; for i = 1, 600 do items[i] = {name = "iron-plate", count = i} end
            ed.specific_data = {inventories = {{items = items}}}
        end
        job.entity_map[2] = {valid = true, type = "beacon", disabled_by_script = true}
    end
    if options.legacyWait then
        job.phase1_started, job.pending_beacon_tick = true, 103
    end
    env.storage.async_jobs.test = job
    for _ = 1, 25 do
        -- Reload module locals each tick: progress must live in the saved job table.
        for _, name in ipairs({"core/async-processor", "core/import-pipeline", "core/import-completion"}) do cache[name] = nil end
        local processor = env.require("modules/surface_export/core/async-processor")
        processor.set_show_progress(false)
        if options.smallBatches then processor.set_batch_size(1) end
        local ok, err = pcall(processor.process_tick)
        assert(scratch == 0, "scratch inventory survived the callback")
        if options.errorAt and (not ok or job.completion_interrupted) then
            -- Re-enter through the real scheduler after reloading Lua modules, as on later ticks.
            local count = #events
            for _ = 1, 3 do
                env.game.tick = env.game.tick + 1
                cache["core/async-processor"] = nil
                processor = env.require("modules/surface_export/core/async-processor")
                pcall(processor.process_tick)
            end
            assert(#events == count, "interrupted " .. options.errorAt .. " repeated side effects")
            assert(job.completion_interrupted, "missing durable interruption evidence")
            assert(not spans.activation or options.errorAt == "publish", "advanced after interruption")
            if options.errorAt == "publish" then
                assert(env.storage.async_job_results.test.complete == false, "interrupted publication reported completion")
            end
            print("PASS " .. options.errorAt .. " exception cannot replay after module reload")
            return
        end
        assert(ok, tostring(err))
        if (options.quarantineFailure or options.partialQuarantine) and job.completion_interrupted then
            assert(env.storage.async_jobs.test == job, "failed quarantine lost exact job references")
            assert(job.target_platform.hidden and job.target_platform.paused)
            local count = #events
            for _ = 1, 3 do env.game.tick = env.game.tick + 1; processor.process_tick() end
            assert(#events == count, "failed quarantine replayed completion")
            if options.partialQuarantine then
                for newer = 1, 30 do env.storage.async_job_results["znewer_" .. newer] = {status = "completed"} end
                env.require("modules/surface_export/core/job-results").prune(25)
                assert(env.storage.async_job_results[job.job_id], "pruning removed evidence owned by interrupted job")
                assert(size(env.storage.async_job_results) == 26, "completed result retention is not bounded")
                local holds = cache["core/destination-hold"]
                assert(holds.get("transfer").preparation_failed)
                assert(not holds.discard("transfer", job.job_id), "refused evacuation cleared interrupted job")
                assert(env.storage.async_jobs.test == job)
                options.evacuation = nil
                assert(holds.discard("transfer", job.job_id), "partial quarantine could not be discarded")
                assert(not env.storage.async_jobs.test and not holds.get("transfer"))
                assert(env.require("modules/surface_export/core/job-status").read("test").state == "failed")
                assert(env.storage.async_job_results.test.validation.cleanup_failed, "cleanup erased original failure")
            end
            print("PASS failed quarantine retains job references and stops completion replay")
            return
        end
        assert(not job.completion_interrupted or options.evacuation, job.completion_interrupted and job.completion_interrupted.error)
        for name, kind in pairs(open) do assert(kind == "wait", "execution spans ticks: " .. name) end
        if not env.storage.async_jobs.test then break end
        assert(job.entity_map[1].disabled_by_script, "entity active between phases")
        assert(job.target_platform.paused, "platform unpaused before verdict")
        env.game.tick = env.game.tick + 1
    end
    assert(env.storage.async_jobs.test == nil, "job never finished")
    assert(not options.inventoryError, "injected exception was not reached")
    local result = env.storage.async_job_results.test
    if options.identity then
        assert(result.target_identity.platform_index == 3 and result.target_identity.surface_index == 8)
        assert(result.target_identity.platform_uid == "fixture-epoch:401" and result.target_identity.force_name == "player")
    end
    assert(result.duration_ticks == env.game.tick - job.started_tick)
    local function eventTicks(name)
        local ticks = {}; for _, e in ipairs(events) do if e.name == name then ticks[#ticks + 1] = e.tick end end
        return ticks
    end
    local function before(first, second)
        local a, b
        for index, event in ipairs(events) do
            if event.name == first then a = index end
            if event.name == second and not b then b = index end
        end
        assert(a and b and a < b, first .. " must precede " .. second)
    end
    assert(#eventTicks("publish") == 1, "completion must publish exactly once")
    before("held_items", "fluids")
    if not options.standalone then
        assert(#eventTicks("validate") == 1, "final cargo gate must execute exactly once")
        before("fluids", "validate")
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
    assert(#eventTicks("publish") == 1, "completion must publish exactly once")
    if options.largeInventory then
        local writes = eventTicks("inventory")
        assert(#writes == 2 and writes[1] < writes[2], "large inventories shared a callback or replayed")
        assert(spans.inventories.callbacks >= 2, "inventory profiler did not accumulate batches")
    end
    if options.smallBatches then assert(spans.beacons.callbacks == 2, "beacon scan did not yield") end
    assert(spans.held_items.endTick < spans.fluids.startTick)
    if options.reject or options.beltFailure or options.holdFailure then
        assert(result.validation.success == false)
        assert(#eventTicks("black_box") == 1, "failure diagnostic must be attempted")
        if not options.holdFailure then assert(not spans.activation) end
        if options.evacuation then
            assert(#eventTicks("discard") == 0 and job.target_platform.valid)
            assert(result.validation.cleanup_failed and result.validation.cleanup_error:find("evacuation"))
            local holds = cache["core/destination-hold"]
            local hold = holds.get("transfer")
            assert(hold and hold.preparation_failed and hold.job_id == job.job_id and hold.platform_uid == "destination-uid")
            assert(job.entity_map[1].disabled_by_script and job.target_platform.hidden and job.target_platform.paused)
            assert(not holds.go_live("transfer", job.job_id), "failed validation authorized release")
            options.evacuation = nil
            assert(holds.discard("transfer", job.job_id), "confirmed evacuation could not retry cleanup")
            assert(not holds.get("transfer") and not job.target_platform.valid)
        elseif options.debug and options.preserve then
            assert(#eventTicks("discard") == 0 and job.target_platform.valid)
            assert(result.validation.destinationPreserved and not env.storage.surface_export_config.preserve_failed_destination)
        else
            assert(#eventTicks("discard") == 1 and not job.target_platform.valid)
            before("black_box", "discard")
        end
    else
        assert(#eventTicks("activate") == 1)
        if not options.standalone then before("validate", "activate") end
        before("activate", "publish")
        assert(spans.activation.startTick == spans.fluids.endTick)
        if not options.standalone then
            assert(result.validation.success == true and #eventTicks("hold") == 1)
            before("activate", "hold")
            before("hold", "publish")
            assert(eventTicks("hold")[1] == spans.activation.endTick, "activation escaped its hold callback")
			if options.snapshot then
				assert(#eventTicks("release") == 1, "validated snapshot remained held for a source deletion that will never arrive")
				assert(eventTicks("release")[1] == eventTicks("hold")[1])
			else assert(#eventTicks("release") == 0, "transfer released before controller acknowledgement") end
        else
            assert(#eventTicks("hold") == 0, "standalone import acquired a transfer hold")
        end
    end
    if not options.standalone then assert(spans.exact_verification.startTick == spans.fluids.endTick) end
    print("PASS " .. options.label .. ": phase yields, persisted progress and final callback boundaries")
end

scenario({label = "transfer"})
scenario({label = "bounded beacon and inventory passes", largeInventory = true, smallBatches = true})
scenario({label = "standalone", standalone = true})
scenario({label = "retained import identity", standalone = true, identity = true})
scenario({label = "validated standalone snapshot", snapshot = true})
scenario({label = "rejected standalone snapshot", snapshot = true, reject = true})
scenario({label = "standalone snapshot hold failure", snapshot = true, holdFailure = true})
scenario({label = "validation rejection", reject = true})
scenario({label = "diagnostic failure still discards", reject = true, blackBoxFailure = true})
scenario({label = "debug preservation", reject = true, debug = true, preserve = true})
scenario({label = "preservation requires debug", reject = true, preserve = true})
for _, mode in ipairs({"refused", "throw", "missing"}) do
    scenario({label = "validation rejection with " .. mode .. " evacuation", reject = true, evacuation = mode})
end
scenario({label = "failed quarantine", reject = true, evacuation = "refused", quarantineFailure = true})
scenario({label = "partial quarantine", reject = true, evacuation = "refused", partialQuarantine = true})
scenario({label = "belt failure", beltFailure = true})
scenario({label = "hold failure", holdFailure = true})
scenario({label = "hold identity collision", holdFailure = true, foreignHold = true})
scenario({label = "existing deferred job", legacyWait = true})
for _, phase in ipairs({"hub", "inventory", "state", "held_items", "fluids", "publish"}) do
    scenario({errorAt = phase})
end
