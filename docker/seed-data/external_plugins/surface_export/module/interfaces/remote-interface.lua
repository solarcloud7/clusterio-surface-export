-- FactorioSurfaceExport - Remote Interface
-- Main loader that registers all remote interface methods from individual files
-- Each method is in its own file under interfaces/remote/

local RemoteInterface = {}

-- Load base utilities
local Base = require("modules/surface_export/interfaces/remote/base")

-- Load individual remote interface functions
local export_platform = require("modules/surface_export/interfaces/remote/export-platform")
local get_export = require("modules/surface_export/interfaces/remote/get-export")
local list_exports = require("modules/surface_export/interfaces/remote/list-exports")
local list_platforms = require("modules/surface_export/interfaces/remote/list-platforms")
local clear_old_exports = require("modules/surface_export/interfaces/remote/clear-old-exports")
local export_platform_to_file = require("modules/surface_export/interfaces/remote/export-platform-to-file")
local import_platform_chunk = require("modules/surface_export/interfaces/remote/import-platform-chunk")
local configure = require("modules/surface_export/interfaces/remote/configure")
local get_validation_result = require("modules/surface_export/interfaces/remote/get-validation-result")
local lock_platform_for_transfer = require("modules/surface_export/interfaces/remote/lock-platform-for-transfer")
local unlock_platform = require("modules/surface_export/interfaces/remote/unlock-platform")
local test_import_entity = require("modules/surface_export/interfaces/remote/test-import-entity")
local test_runner = require("modules/surface_export/interfaces/remote/test-runner")
local clone_platform = require("modules/surface_export/interfaces/remote/clone-platform")
local version_selftest = require("modules/surface_export/interfaces/remote/version-selftest")
local selection_lab_drive = require("modules/surface_export/interfaces/remote/selection-lab-drive")
local belt_side_restore_selftest = require("modules/surface_export/interfaces/remote/belt-side-restore-selftest")
local gateway_selftest = require("modules/surface_export/interfaces/remote/gateway-selftest")
local schedule_selftest = require("modules/surface_export/interfaces/remote/schedule-selftest")
local transfer_lock_selftest = require("modules/surface_export/interfaces/remote/transfer-lock-selftest")
local no_tick_sync_selftest = require("modules/surface_export/interfaces/remote/no-tick-sync-selftest")
local hold_aware_unlock_selftest = require("modules/surface_export/interfaces/remote/hold-aware-unlock-selftest")
local delete_platform_for_transfer = require("modules/surface_export/interfaces/remote/delete-platform-for-transfer")
local get_source_transfer_lock_state = require("modules/surface_export/interfaces/remote/get-source-transfer-lock-state")
local destination_hold = require("modules/surface_export/interfaces/remote/destination-hold")

-- Expose functions for direct Lua access (not just remote interface)
RemoteInterface.export_platform = export_platform
RemoteInterface.get_export = get_export
RemoteInterface.list_exports = list_exports
RemoteInterface.list_platforms = list_platforms
RemoteInterface.clear_old_exports = clear_old_exports
RemoteInterface.export_platform_to_file = export_platform_to_file
RemoteInterface.import_platform_chunk = import_platform_chunk
RemoteInterface.configure = configure
RemoteInterface.get_validation_result = get_validation_result
RemoteInterface.lock_platform_for_transfer = lock_platform_for_transfer
RemoteInterface.unlock_platform = unlock_platform
RemoteInterface.test_import_entity = test_import_entity
RemoteInterface.test_runner = test_runner
RemoteInterface.clone_platform = clone_platform
RemoteInterface.version_selftest = version_selftest
RemoteInterface.selection_lab_drive = selection_lab_drive
RemoteInterface.belt_side_restore_selftest = belt_side_restore_selftest
RemoteInterface.gateway_selftest = gateway_selftest
RemoteInterface.schedule_selftest = schedule_selftest
RemoteInterface.transfer_lock_selftest = transfer_lock_selftest
RemoteInterface.no_tick_sync_selftest = no_tick_sync_selftest
RemoteInterface.hold_aware_unlock_selftest = hold_aware_unlock_selftest
RemoteInterface.delete_platform_for_transfer = delete_platform_for_transfer
RemoteInterface.get_source_transfer_lock_state = get_source_transfer_lock_state
RemoteInterface.destination_hold = destination_hold

-- JSON-wrapped versions for RCON access
RemoteInterface.get_export_json = Base.json_wrap(get_export)
RemoteInterface.list_exports_json = Base.json_wrap(list_exports)
RemoteInterface.list_platforms_json = Base.json_wrap(list_platforms)
RemoteInterface.get_validation_result_json = Base.json_wrap(get_validation_result)

--- Register all remote interface methods
function RemoteInterface.register()
  remote.add_interface("surface_export", {
    -- Export methods
    export_platform = export_platform,
    export_platform_to_file = export_platform_to_file,
    get_export = get_export,
    get_export_json = Base.json_wrap(get_export),
    list_exports = list_exports,
    list_exports_json = Base.json_wrap(list_exports),
    list_platforms = list_platforms,
    list_platforms_json = Base.json_wrap(list_platforms),
    clear_old_exports = clear_old_exports,
    
    -- Import method
    import_platform_chunk = import_platform_chunk,
    
    -- Configuration
    configure = configure,
    
    -- Validation
    get_validation_result = get_validation_result,
    get_validation_result_json = Base.json_wrap(get_validation_result),
    
    -- Platform locking
    lock_platform_for_transfer = lock_platform_for_transfer,
    unlock_platform = unlock_platform,
    
    -- Debug/testing
    test_import_entity = test_import_entity,
    run_tests = test_runner.run_tests,
    run_tests_json = Base.json_wrap(test_runner.run_tests),
    clone_platform = clone_platform,
    clone_platform_json = Base.json_wrap(clone_platform),
    version_selftest = version_selftest,
    version_selftest_json = Base.json_wrap(version_selftest),
    selection_lab_drive = selection_lab_drive,
    selection_lab_drive_json = Base.json_wrap(selection_lab_drive),
    belt_side_restore_selftest = belt_side_restore_selftest,
    belt_side_restore_selftest_json = Base.json_wrap(belt_side_restore_selftest),
    gateway_selftest = gateway_selftest,
    gateway_selftest_json = Base.json_wrap(gateway_selftest),
    schedule_selftest = schedule_selftest,
    schedule_selftest_json = Base.json_wrap(schedule_selftest),
    transfer_lock_selftest = transfer_lock_selftest,
    transfer_lock_selftest_json = Base.json_wrap(transfer_lock_selftest),
    no_tick_sync_selftest = no_tick_sync_selftest,
    no_tick_sync_selftest_json = Base.json_wrap(no_tick_sync_selftest),
    hold_aware_unlock_selftest = hold_aware_unlock_selftest,
    hold_aware_unlock_selftest_json = Base.json_wrap(hold_aware_unlock_selftest),
    delete_platform_for_transfer = delete_platform_for_transfer,
    get_source_transfer_lock_state = get_source_transfer_lock_state,
    get_source_transfer_lock_state_json = Base.json_wrap(get_source_transfer_lock_state),
    destination_hold = destination_hold,
    destination_hold_json = Base.json_wrap(destination_hold),
  })
end

return RemoteInterface
