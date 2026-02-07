-- Surface Export Clusterio Module (Save-patched)
-- Integrates FactorioSurfaceExport with Clusterio for cross-instance platform transfers

local clusterio_api = require("modules/clusterio/api")

-- Import existing functionality
local RemoteInterface = require("modules/surface_export/interfaces/remote-interface")
local Commands = require("modules/surface_export/interfaces/commands")
local AsyncProcessor = require("modules/surface_export/core/async-processor")
local SurfaceLock = require("modules/surface_export/utils/surface-lock")

-- ============================================================================
-- Initialization
-- ============================================================================

script.on_init(function()
	storage.platform_exports = storage.platform_exports or {}
	storage.pending_platform_imports = storage.pending_platform_imports or {}
	storage.surface_export = storage.surface_export or {}
	AsyncProcessor.init()

	-- Disable auto-pause for headless server operation
	if game.is_multiplayer() then
		game.permissions.get_group("Default").set_allows_action(defines.input_action.toggle_map_editor, false)
	end

	game.print("[Surface Export] Clusterio module initialized")
	log("[Surface Export] Save-patched module loaded with Clusterio support")
end)

script.on_load(function()
	-- Restore any necessary state (cannot modify global here in Factorio 2.0)
end)

script.on_configuration_changed(function()
	-- Initialize storage if this is an existing save without the module
	storage.platform_exports = storage.platform_exports or {}
	storage.pending_platform_imports = storage.pending_platform_imports or {}
	storage.surface_export = storage.surface_export or {}
	AsyncProcessor.init()
	
	-- Auto-unpause game for headless server operation
	game.tick_paused = false
	
	log("[Surface Export] Configuration changed - module state initialized")
end)

-- ============================================================================
-- Remote Interface Registration
-- ============================================================================

-- Register the full remote interface (export, import, chunking, etc.)
RemoteInterface.register()

-- Register console commands for manual testing
Commands.register()

-- ============================================================================
-- Async Processing
-- ============================================================================

-- Process async import/export jobs every tick
script.on_event(defines.events.on_tick, function()
	AsyncProcessor.process_tick()
	
	-- Check for step-tick target (re-pause after stepping)
	if storage.step_tick_target and game.tick >= storage.step_tick_target then
		game.tick_paused = true
		game.print(string.format("[Debug] Paused at tick %d", game.tick), {0.5, 1, 0.5})
		storage.step_tick_target = nil
	end
	
	-- Process pending platform imports (waiting for surface initialization)
	-- Initialize storage.pending_platform_imports if it doesn't exist (for save compatibility)
	-- Legacy pending_platform_imports system removed - async imports handle this via AsyncProcessor
	-- Platform surface waiting is handled automatically in the async import job
end)

-- ============================================================================
-- Clusterio Events
-- ============================================================================

-- Called when instance starts
script.on_event(clusterio_api.events.on_server_startup, function()
	game.print("[Surface Export] Clusterio connected")
	log("[Surface Export] Connected to Clusterio controller")
end)

-- Called when instance config changes
script.on_event(clusterio_api.events.on_instance_updated, function()
	-- Handle config updates if needed
	log("[Surface Export] Instance configuration updated")
end)

-- ============================================================================
-- Configuration Changes
-- ============================================================================

script.on_configuration_changed(function(data)
	storage.platform_exports = storage.platform_exports or {}
	AsyncProcessor.init()

	if data.mod_changes and data.mod_changes["FactorioSurfaceExport"] then
		local old_version = data.mod_changes["FactorioSurfaceExport"].old_version
		local new_version = data.mod_changes["FactorioSurfaceExport"].new_version
		game.print(string.format("[Surface Export] Updated from %s to %s",
			old_version or "none",
			new_version or "1.0.89"
		))
	end
end)
		local RemoteInterface = require("modules/surface_export/interfaces/remote-interface")
		local Commands = require("modules/surface_export/interfaces/commands")
		local AsyncProcessor = require("modules/surface_export/core/async-processor")
-- ============================================================================

-- The remote interface provides these key functions for Clusterio:
--
-- For exports:
--   remote.call("FactorioSurfaceExport", "export_platform", platform_index, force_name)
--   remote.call("FactorioSurfaceExport", "export_platform_to_file", platform_index, force_name, filename)
--
-- For imports (MUST use RCON chunking in Factorio 2.0):
--   remote.call("FactorioSurfaceExport", "import_platform_chunk", platform_name, chunk_data, chunk_num, total_chunks, force_name)
--   remote.call("FactorioSurfaceExport", "get_import_status", job_id)
--
-- IMPORTANT: import_platform_file_async() is DEPRECATED in Factorio 2.0
-- because Lua can no longer read files at runtime. All imports must go
-- through RCON using the chunking interface above.
