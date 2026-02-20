-- Surface Export Clusterio Module (Save-patched)
-- Integrates FactorioSurfaceExport with Clusterio for cross-instance platform transfers
--
-- IMPORTANT: This module uses the event_handler interface required by Clusterio.
-- Do NOT use script.on_init, script.on_event, etc. directly — that would
-- overwrite Clusterio's own event handlers and break initialization.
-- See: https://github.com/clusterio/clusterio/blob/main/docs/developing-for-clusterio.md

local clusterio_api = require("modules/clusterio/api")

-- Import existing functionality
local RemoteInterface = require("modules/surface_export/interfaces/remote-interface")
local Commands = require("modules/surface_export/interfaces/commands")
local AsyncProcessor = require("modules/surface_export/core/async-processor")
local SurfaceLock = require("modules/surface_export/utils/surface-lock")

-- Top-level module table (event_handler interface)
local SurfaceExportModule = {}

-- ============================================================================
-- Initialization (event_handler callbacks)
-- ============================================================================

local function initialize_storage()
	storage.platform_exports = storage.platform_exports or {}
	storage.pending_platform_imports = storage.pending_platform_imports or {}
	storage.surface_export = storage.surface_export or {}
	storage.surface_export_config = storage.surface_export_config or { debug_mode = true }
	storage.platform_flight_data = storage.platform_flight_data or {}
	AsyncProcessor.init()
end

function SurfaceExportModule.on_init()
	initialize_storage()
	log("[Surface Export] Save-patched module loaded with Clusterio support")
end

function SurfaceExportModule.on_load()
	-- Restore any necessary state (cannot modify global here in Factorio 2.0)
end

function SurfaceExportModule.on_configuration_changed(data)
	initialize_storage()
	log("[Surface Export] Configuration changed - module state initialized")
end

-- ============================================================================
-- Remote Interface & Commands Registration
-- (add_remote_interface is called before on_init/on_load per event_handler)
-- ============================================================================

function SurfaceExportModule.add_remote_interface()
	RemoteInterface.register()
end

function SurfaceExportModule.add_commands()
	Commands.register()
end

-- ============================================================================
-- Event Handlers (event_handler interface)
-- ============================================================================

local e = defines.events

SurfaceExportModule.events = {
	-- Process async import/export jobs every tick
	[e.on_tick] = function()
		AsyncProcessor.process_tick()
	end,

	-- Clusterio custom events
	[clusterio_api.events.on_server_startup] = function()
		initialize_storage()
		log("[Surface Export] Connected to Clusterio controller")
	end,

	[clusterio_api.events.on_instance_updated] = function()
		log("[Surface Export] Instance configuration updated")
	end,

	[e.on_space_platform_changed_state] = function(event)
		local platform = event.platform
		if not (platform and platform.valid) then return end

		-- CRITICAL: Space platforms use defines.space_platform_state, NOT defines.train_state
		local sps = defines.space_platform_state

		-- Track flight start time and estimated duration; clear on arrival
		storage.platform_flight_data = storage.platform_flight_data or {}
		if platform.state == sps.on_the_path then
			local est_ticks = nil
			local ok, result = pcall(function()
				local src = platform.space_location
				-- Read destination from schedule (platform.current_target does NOT exist)
				local schedule = platform.schedule
				local tgt_name = nil
				if schedule and schedule.records and schedule.current then
					tgt_name = schedule.records[schedule.current].station
				end
				if src and tgt_name and platform.speed and platform.speed > 0 then
					local tgt = game.space_location_prototypes[tgt_name]
					if tgt then
						return math.floor(math.abs((tgt.distance or 0) - (src.distance or 0)) / platform.speed)
					end
				end
			end)
			if ok then est_ticks = result end
			storage.platform_flight_data[platform.name] = {
				departure_tick = game.tick,
				estimated_duration_ticks = est_ticks,
			}
		elseif platform.state == sps.waiting_at_station then
			storage.platform_flight_data[platform.name] = nil
		end

		-- Notify the controller so it can push a tree refresh to web subscribers
		if not (clusterio_api and clusterio_api.send_json) then return end
		local ok2, err = pcall(function()
			clusterio_api.send_json("surface_platform_state_changed", {
				platform_name = platform.name,
				force_name = platform.force and platform.force.name or "player",
			})
		end)
		if not ok2 then
			log(string.format("[Surface Export] ERROR sending platform state send_json event: %s", tostring(err)))
		end
	end,
}

-- ============================================================================
-- API Documentation
-- ============================================================================

-- The remote interface "surface_export" provides these key functions:
--
-- For exports:
--   remote.call("surface_export", "export_platform", platform_index, force_name)
--   remote.call("surface_export", "export_platform_to_file", platform_index, force_name, filename)
--   remote.call("surface_export", "get_export", export_id)
--   remote.call("surface_export", "get_export_json", export_id)  -- JSON string for RCON
--   remote.call("surface_export", "list_exports")
--   remote.call("surface_export", "list_exports_json")  -- JSON string for RCON
--   remote.call("surface_export", "clear_old_exports", max_to_keep)
--
-- For imports (chunked RCON — Factorio 2.0 cannot read files at runtime):
--   remote.call("surface_export", "import_platform_chunk", platform_name, chunk_data, chunk_num, total_chunks, force_name)
--
-- For platform locking (transfer workflow):
--   remote.call("surface_export", "lock_platform_for_transfer", platform_index, force_name)
--   remote.call("surface_export", "unlock_platform", platform_name)
--
-- For validation:
--   remote.call("surface_export", "get_validation_result", platform_name)
--   remote.call("surface_export", "get_validation_result_json", platform_name)
--
-- Configuration:
--   remote.call("surface_export", "configure", config_table)
--
-- Debug/testing:
--   remote.call("surface_export", "test_import_entity", entity_json, surface_index, position)
--   remote.call("surface_export", "run_tests")
--   remote.call("surface_export", "clone_platform", platform_index, force_name, new_name)

return SurfaceExportModule
