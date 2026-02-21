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
local get_asset_paths = require("modules/surface_export/interfaces/remote/get-asset-paths")

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
RemoteInterface.get_planet_icon_paths = get_asset_paths.get_planet_icon_paths
RemoteInterface.get_prototype_icon_path = get_asset_paths.get_prototype_icon_path

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

    -- Asset path discovery (for Web UI icons)
    get_planet_icon_paths = get_asset_paths.get_planet_icon_paths,
    get_planet_icon_paths_json = Base.json_wrap(get_asset_paths.get_planet_icon_paths),
    get_prototype_icon_path = get_asset_paths.get_prototype_icon_path,
  })
end

return RemoteInterface
