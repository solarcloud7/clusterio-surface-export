local root = "docker/seed-data/external_plugins/surface_export/module/"
local function check(condition, message) assert(condition, message) end
local scanned, bundle, published, failed_phase, history
local scan_error, output_error, publish_error, debug_error
local scanner = {}
local validation = {success = false, failedStage = "belts", mismatchDetails = "rejected", cleanup_failed = true,
    cleanup_error = "evacuation refused", destinationPreserved = true,
    expectedItemCounts = {iron = 2}, actualItemCounts = {iron = 1}, expectedFluidCounts = {water = 5}, actualFluidCounts = {water = 4}}
local job = {job_id = "job", platform_name = "test", transfer_id = "123:export", operation_id = "operation", source_instance_id = 123,
    force_name = "player", started_tick = 1, target_surface = {valid = true}, target_platform = {valid = true, name = "test"},
    metrics = {delivery_started_tick = 2, inventory_state_failed = 3}, total_entities = 4, platform_data = {payload = true}}
local spans = {{phase = "belts", ticks = 0}}
local deps = {
    ["export_scanners/fluid-registry"] = {new = function() return {} end, list = function() return {"segment"} end},
    ["export_scanners/inventory-scanner"] = scanner,
    ["export_scanners/entity-scanner"] = {scan_surface = function(surface)
        check(scanner.fluid_registry ~= nil, "physical scan has no fluid registry")
        if scan_error then error("scan refused") end
        scanned = surface
        return {{name = "belt"}}
    end},
    ["utils/debug-export"] = {
        destination_snapshot_enabled = function() return true end,
        export_destination_platform = function(data) bundle = data; if not output_error then return "snapshot.json" end end,
        export_import_result = function() if debug_error then error("debug write refused") end end,
        write_failure_black_box = function(_, data) bundle = data; return "failure.json" end,
    },
    ["utils/platform-schedule"] = {capture = function() return {paused = true} end},
    ["utils/operation-timing"] = {start = function() end, stop = function() end,
        fail = function(_, phase) failed_phase = phase end,
        scope = function(_, _, fn, ...) return fn(...) end},
    ["import_phases/belt_restoration"] = {attribute_lines = function() return {"left", "right"} end},
    ["utils/game-utils"] = {FORCE_SYNC_PROPS = {}},
    ["utils/util"] = {parse_fluid_temp_key = function(key) return key end},
    ["utils/phase-profiler"] = {get = function() return {} end, discard = function() end},
    ["utils/phase-recorder"] = {phase_ticks = function() return 0 end, build_spans = function() return spans end},
    ["utils/transaction-history"] = {record_import = function(j, v) history = {j, v} end},
}
local env = setmetatable({storage = {async_job_results = {job = {}}}, game = {tick = 10, forces = {player = {}}},
    script = {active_mods = {base = "2.1.17"}}, log = function() end}, {__index = _G})
env.require = function(path)
    if path == "modules/clusterio/api" then return {send_json = function(channel, event)
        check(channel == "surface_export_import_complete", "wrong event")
        check(env.storage.async_job_results.job.completion == event, "event published before retention")
        if publish_error then error("lost publish") end
        published = event
    end} end
    return assert(deps[path:gsub("^modules/surface_export/", "")], path)
end
local reporting = assert(loadfile(root .. "core/import-reporting.lua", "t", env))()
reporting.capture_destination(job)
check(scanned == job.target_surface and bundle.entity_count == 1, "snapshot lost physical capture")
check(scanner.fluid_registry == nil, "snapshot leaked scanner state")
output_error = true
reporting.capture_destination(job)
check(failed_phase == "diagnostic_output", "missing output was not marked unavailable")
scan_error = true
reporting.capture_destination(job)
check(failed_phase == "diagnostic_capture" and scanner.fluid_registry == nil, "failed scan leaked scanner state")
check(reporting.bank_failure_black_box(job, validation), "failure evidence not banked")
check(bundle.physical_capture_available == false and bundle.physical_capture_error, "failed scan fabricated physical evidence")
check(bundle.replay_payload == job.platform_data and bundle.diff.items.iron.delta == -1, "failure evidence changed")
check(validation.failureBlackBox.file == "failure.json", "failure reference lost")
debug_error = true
reporting.publish(job, validation, 9)
check(published.success == false and published.validation == validation and published.cleanup_failed, "failure verdict changed")
check(published.failed_stage == "belts" and published.cleanup_error == "evacuation refused" and published.destination_preserved, "recovery evidence lost")
check(published.transfer_id == job.transfer_id and published.operation_id == job.operation_id, "identity lost")
check(published.duration_ticks == 9 and published.metrics.phase_ticks == spans and published.metrics.belts_ticks == 0, "tick evidence changed")
check(published.metrics.inventory_state_failed == 3, "restoration metric lost")
publish_error = true
check(not pcall(reporting.publish, job, validation, 9), "publication failure swallowed instead of reaching quarantine")
check(env.storage.async_job_results.job.completion.validation == validation, "publication failure lost retained verdict")
reporting.record_performance(job, validation)
check(history[1] == job and history[2] == validation, "history changed")
print("PASS import reporting: snapshots, unavailable captures, failed verdicts, retention-before-publication and history")
