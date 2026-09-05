local RemoteInterface = {}

local Base = require("modules/surface_export/interfaces/remote/base")

local module_version = require("modules/surface_export/version")
local function get_module_version()
  return module_version
end

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
local reapply_gateway_locks = require("modules/surface_export/interfaces/remote/reapply-gateway-locks")
local test_import_entity = require("modules/surface_export/interfaces/remote/test-import-entity")
local test_runner = require("modules/surface_export/interfaces/remote/test-runner")
local clone_platform = require("modules/surface_export/interfaces/remote/clone-platform")
local version_selftest = require("modules/surface_export/interfaces/remote/version-selftest")
local selection_lab_drive = require("modules/surface_export/interfaces/remote/selection-lab-drive")
local belt_side_restore_selftest = require("modules/surface_export/interfaces/remote/belt-side-restore-selftest")
local inventory_import_guard_selftest = require("modules/surface_export/interfaces/remote/inventory-import-guard-selftest")
local gateway_selftest = require("modules/surface_export/interfaces/remote/gateway-selftest")
local schedule_selftest = require("modules/surface_export/interfaces/remote/schedule-selftest")
local transfer_lock_selftest = require("modules/surface_export/interfaces/remote/transfer-lock-selftest")
local no_tick_sync_selftest = require("modules/surface_export/interfaces/remote/no-tick-sync-selftest")
local fluid_segment_law_selftest = require("modules/surface_export/interfaces/remote/fluid-segment-law-selftest")
local pole_copper_prune_selftest = require("modules/surface_export/interfaces/remote/pole-copper-prune-selftest")
local hold_aware_unlock_selftest = require("modules/surface_export/interfaces/remote/hold-aware-unlock-selftest")
local export_cache_selftest = require("modules/surface_export/interfaces/remote/export-cache-selftest")
local blueprint_diff_selftest = require("modules/surface_export/interfaces/remote/blueprint-diff-selftest")
local import_target_selftest = require("modules/surface_export/interfaces/remote/import-target-selftest")
local signal_stability_selftest = require("modules/surface_export/interfaces/remote/signal-stability-selftest")
local latch_rearm_params_selftest = require("modules/surface_export/interfaces/remote/latch-rearm-params-selftest")
local configure_gateways_remote = require("modules/surface_export/interfaces/remote/configure-gateways")
local gateway_config_staging_selftest = require("modules/surface_export/interfaces/remote/gateway-config-staging-selftest")
local delete_platform_for_transfer = require("modules/surface_export/interfaces/remote/delete-platform-for-transfer")
local get_source_transfer_lock_state = require("modules/surface_export/interfaces/remote/get-source-transfer-lock-state")
local destination_hold = require("modules/surface_export/interfaces/remote/destination-hold")
local test_roster = require("modules/surface_export/interfaces/remote/test-roster")
local lifecycle = require("modules/surface_export/interfaces/remote/lifecycle")
local teleport_roster_update = require("modules/surface_export/interfaces/remote/teleport-roster")

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
RemoteInterface.reapply_gateway_locks = reapply_gateway_locks
RemoteInterface.test_import_entity = test_import_entity
RemoteInterface.test_runner = test_runner
RemoteInterface.clone_platform = clone_platform
RemoteInterface.version_selftest = version_selftest
RemoteInterface.get_module_version = get_module_version
RemoteInterface.teleport_roster_update = teleport_roster_update
RemoteInterface.selection_lab_drive = selection_lab_drive
RemoteInterface.belt_side_restore_selftest = belt_side_restore_selftest
RemoteInterface.inventory_import_guard_selftest = inventory_import_guard_selftest
RemoteInterface.gateway_selftest = gateway_selftest
RemoteInterface.schedule_selftest = schedule_selftest
RemoteInterface.transfer_lock_selftest = transfer_lock_selftest
RemoteInterface.no_tick_sync_selftest = no_tick_sync_selftest
RemoteInterface.fluid_segment_law_selftest = fluid_segment_law_selftest
RemoteInterface.pole_copper_prune_selftest = pole_copper_prune_selftest
RemoteInterface.hold_aware_unlock_selftest = hold_aware_unlock_selftest
RemoteInterface.export_cache_selftest = export_cache_selftest
RemoteInterface.blueprint_diff_selftest = blueprint_diff_selftest
RemoteInterface.import_target_selftest = import_target_selftest
RemoteInterface.signal_stability_selftest = signal_stability_selftest
RemoteInterface.latch_rearm_params_selftest = latch_rearm_params_selftest
RemoteInterface.configure_gateways = configure_gateways_remote.configure_gateways
RemoteInterface.configure_gateways_begin = configure_gateways_remote.configure_gateways_begin
RemoteInterface.configure_gateways_chunk = configure_gateways_remote.configure_gateways_chunk
RemoteInterface.configure_gateways_commit = configure_gateways_remote.configure_gateways_commit
RemoteInterface.gateway_config_staging_selftest = gateway_config_staging_selftest
RemoteInterface.delete_platform_for_transfer = delete_platform_for_transfer
RemoteInterface.get_source_transfer_lock_state = get_source_transfer_lock_state
RemoteInterface.destination_hold = destination_hold
RemoteInterface.set_test_roster = test_roster.set_test_roster
RemoteInterface.set_test_roster_begin = test_roster.set_test_roster_begin
RemoteInterface.set_test_roster_chunk = test_roster.set_test_roster_chunk
RemoteInterface.set_test_roster_commit = test_roster.set_test_roster_commit
RemoteInterface.get_test_roster_summary = test_roster.get_test_roster_summary
RemoteInterface.lifecycle_setup = lifecycle.lifecycle_setup
RemoteInterface.lifecycle_dest_setup = lifecycle.lifecycle_dest_setup
RemoteInterface.lifecycle_verify = lifecycle.lifecycle_verify
RemoteInterface.lifecycle_teardown = lifecycle.lifecycle_teardown
RemoteInterface.lifecycle_leftovers = lifecycle.lifecycle_leftovers

RemoteInterface.get_export_json = Base.json_wrap(get_export)
RemoteInterface.list_exports_json = Base.json_wrap(list_exports)
RemoteInterface.list_platforms_json = Base.json_wrap(list_platforms)
RemoteInterface.get_validation_result_json = Base.json_wrap(get_validation_result)

function RemoteInterface.register()
  remote.add_interface("surface_export", {
    export_platform = export_platform,
    export_platform_to_file = export_platform_to_file,
    get_export = get_export,
    get_export_json = Base.json_wrap(get_export),
    list_exports = list_exports,
    list_exports_json = Base.json_wrap(list_exports),
    list_platforms = list_platforms,
    list_platforms_json = Base.json_wrap(list_platforms),
    clear_old_exports = clear_old_exports,
    
    import_platform_chunk = import_platform_chunk,
    
    configure = configure,
    
    get_validation_result = get_validation_result,
    get_validation_result_json = Base.json_wrap(get_validation_result),
    
    lock_platform_for_transfer = lock_platform_for_transfer,
    unlock_platform = unlock_platform,
    reapply_gateway_locks = reapply_gateway_locks,
    
    test_import_entity = test_import_entity,
    run_tests = test_runner.run_tests,
    run_tests_json = Base.json_wrap(test_runner.run_tests),
    clone_platform = clone_platform,
    clone_platform_json = Base.json_wrap(clone_platform),
    version_selftest = version_selftest,
    version_selftest_json = Base.json_wrap(version_selftest),
    get_module_version = get_module_version,
    teleport_roster_update = teleport_roster_update,
    selection_lab_drive = selection_lab_drive,
    selection_lab_drive_json = Base.json_wrap(selection_lab_drive),
    belt_side_restore_selftest = belt_side_restore_selftest,
    belt_side_restore_selftest_json = Base.json_wrap(belt_side_restore_selftest),
    inventory_import_guard_selftest = inventory_import_guard_selftest,
    inventory_import_guard_selftest_json = Base.json_wrap(inventory_import_guard_selftest),
    gateway_selftest = gateway_selftest,
    gateway_selftest_json = Base.json_wrap(gateway_selftest),
    schedule_selftest = schedule_selftest,
    schedule_selftest_json = Base.json_wrap(schedule_selftest),
    transfer_lock_selftest = transfer_lock_selftest,
    transfer_lock_selftest_json = Base.json_wrap(transfer_lock_selftest),
    export_cache_selftest = export_cache_selftest,
    export_cache_selftest_json = Base.json_wrap(export_cache_selftest),
    blueprint_diff_selftest = blueprint_diff_selftest,
    blueprint_diff_selftest_json = Base.json_wrap(blueprint_diff_selftest),
    import_target_selftest = import_target_selftest,
    import_target_selftest_json = Base.json_wrap(import_target_selftest),
    signal_stability_selftest = signal_stability_selftest,
    signal_stability_selftest_json = Base.json_wrap(signal_stability_selftest),
    latch_rearm_params_selftest = latch_rearm_params_selftest,
    latch_rearm_params_selftest_json = Base.json_wrap(latch_rearm_params_selftest),
    configure_gateways = configure_gateways_remote.configure_gateways,
    configure_gateways_begin = configure_gateways_remote.configure_gateways_begin,
    configure_gateways_chunk = configure_gateways_remote.configure_gateways_chunk,
    configure_gateways_commit = configure_gateways_remote.configure_gateways_commit,
    gateway_config_staging_selftest = gateway_config_staging_selftest,
    gateway_config_staging_selftest_json = Base.json_wrap(gateway_config_staging_selftest),
    no_tick_sync_selftest = no_tick_sync_selftest,
    no_tick_sync_selftest_json = Base.json_wrap(no_tick_sync_selftest),
    fluid_segment_law_selftest = fluid_segment_law_selftest,
    fluid_segment_law_selftest_json = Base.json_wrap(fluid_segment_law_selftest),
    pole_copper_prune_selftest = pole_copper_prune_selftest,
    pole_copper_prune_selftest_json = Base.json_wrap(pole_copper_prune_selftest),
    hold_aware_unlock_selftest = hold_aware_unlock_selftest,
    hold_aware_unlock_selftest_json = Base.json_wrap(hold_aware_unlock_selftest),
    delete_platform_for_transfer = delete_platform_for_transfer,
    get_source_transfer_lock_state = get_source_transfer_lock_state,
    get_source_transfer_lock_state_json = Base.json_wrap(get_source_transfer_lock_state),
    destination_hold = destination_hold,
    destination_hold_json = Base.json_wrap(destination_hold),

    set_test_roster = test_roster.set_test_roster,
    set_test_roster_json = Base.json_wrap(test_roster.set_test_roster),
    set_test_roster_begin = test_roster.set_test_roster_begin,
    set_test_roster_chunk = test_roster.set_test_roster_chunk,
    set_test_roster_commit = test_roster.set_test_roster_commit,
    get_test_roster_summary = test_roster.get_test_roster_summary,
    get_test_roster_summary_json = Base.json_wrap(test_roster.get_test_roster_summary),

    lifecycle_setup = lifecycle.lifecycle_setup,
    lifecycle_dest_setup = lifecycle.lifecycle_dest_setup,
    lifecycle_verify = lifecycle.lifecycle_verify,
    lifecycle_teardown = lifecycle.lifecycle_teardown,
    lifecycle_leftovers = lifecycle.lifecycle_leftovers,
  })
end

return RemoteInterface
