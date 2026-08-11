local clusterio_api = require("modules/clusterio/api")

local RemoteInterface = require("modules/surface_export/interfaces/remote-interface")
local Commands = require("modules/surface_export/interfaces/commands")
local AsyncProcessor = require("modules/surface_export/core/async-processor")
local SurfaceLock = require("modules/surface_export/utils/surface-lock")
local TransactionDashboard = require("modules/surface_export/interfaces/gui/transaction-dashboard")
local TeleportGui = require("modules/surface_export/interfaces/gui/teleport-gui")
local GatewayTransferGui = require("modules/surface_export/interfaces/gui/gateway-transfer")
local SelectionLab = require("modules/surface_export/interfaces/gui/selection-lab")
local Gateway = require("modules/surface_export/core/gateway")
local GameUtils = require("modules/surface_export/utils/game-utils")

local SurfaceExportModule = {}

local deleting_platform_surface_forces = {}


local function initialize_storage()
	storage.platform_exports = storage.platform_exports or {}
	storage.pending_platform_imports = storage.pending_platform_imports or {}
	storage.surface_export = storage.surface_export or {}
	storage.surface_export_config = storage.surface_export_config or { debug_mode = true }
	storage.surface_export_config.gateways = storage.surface_export_config.gateways or {}
	storage.platform_flight_data = storage.platform_flight_data or {}
	AsyncProcessor.init()
end

function SurfaceExportModule.on_init()
	initialize_storage()
	log("[Surface Export] Save-patched module loaded with Clusterio support")
end

function SurfaceExportModule.on_load()
end

function SurfaceExportModule.on_configuration_changed(data)
	initialize_storage()
	SurfaceLock.ensure_index_keyed()
	Gateway.discover_and_unlock()
	log("[Surface Export] Configuration changed - module state initialized")
end


function SurfaceExportModule.add_remote_interface()
	RemoteInterface.register()
end

function SurfaceExportModule.add_commands()
	Commands.register()
end


local e = defines.events

SurfaceExportModule.events = {
	[e.on_tick] = function()
		AsyncProcessor.process_tick()
		if game.tick % 60 == 0 then
			SurfaceLock.scan_transfer_expiries()
		end
	end,

	[clusterio_api.events.on_server_startup] = function()
		initialize_storage()
		Gateway.discover_and_unlock()
		TeleportGui.ensure_permission_group()
		log("[Surface Export] Connected to Clusterio controller")
	end,

	[clusterio_api.events.on_instance_updated] = function()
		log("[Surface Export] Instance configuration updated")
	end,

	[e.on_space_platform_changed_state] = function(event)
		local platform = event.platform
		if not (platform and platform.valid) then return end

		local sps = defines.space_platform_state

		storage.platform_flight_data = storage.platform_flight_data or {}
		if platform.state == sps.on_the_path then
			local est_ticks = nil
			local ok, result = pcall(function()
				local src = platform.space_location
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
			if ok then
				est_ticks = result
			else
				log(string.format("[Surface Export] ERROR computing flight duration estimate for '%s': %s",
					tostring(platform.name), tostring(result)))
			end
			storage.platform_flight_data[platform.name] = {
				departure_tick = game.tick,
				estimated_duration_ticks = est_ticks,
			}
		elseif platform.state == sps.waiting_at_station then
			storage.platform_flight_data[platform.name] = nil

			local gw_name = Gateway.parked_at_gateway(platform)
			if gw_name then
				log(string.format("[Gateway] Platform '%s' (force '%s') arrived at gateway '%s'",
					tostring(platform.name),
					tostring(platform.force and platform.force.name or "?"),
					gw_name))

				local cfg = Gateway.get_gateway_config(gw_name)
				if cfg and cfg.targets and #cfg.targets > 0 then
					local surf_idx = platform.surface.index
					for _, player in pairs(game.connected_players) do
						-- intentional probe; a surface_index read failure just means this player doesn't get
						local ok, si = pcall(function() return player.surface_index end)
						if ok and si == surf_idx then
							GameUtils.pcall_warn("[Gateway] open arrival chooser", function()
								GatewayTransferGui.open(player, platform, gw_name)
							end)
						end
					end
				end
			end
		end

		if not (clusterio_api and clusterio_api.send_json) then return end
		GameUtils.pcall_warn("[Surface Export] send_json surface_platform_state_changed", function()
			clusterio_api.send_json("surface_platform_state_changed", {
				platform_name = platform.name,
				force_name = platform.force and platform.force.name or "player",
			})
		end)
	end,

	[e.on_pre_surface_deleted] = function(event)
		local surface = game.get_surface(event.surface_index)
		local platform = surface and surface.platform
		if not (platform and platform.valid) then return end
		deleting_platform_surface_forces[event.surface_index] =
			platform.force and platform.force.name or "player"
	end,

	[e.on_surface_deleted] = function(event)
		local force_name = deleting_platform_surface_forces[event.surface_index]
		if not force_name then return end
		deleting_platform_surface_forces[event.surface_index] = nil

		if not (clusterio_api and clusterio_api.send_json) then return end
		GameUtils.pcall_warn("[Surface Export] send_json surface_platform_state_changed (surface deleted)", function()
			clusterio_api.send_json("surface_platform_state_changed", {
				force_name = force_name,
			})
		end)
	end,

	[e.on_gui_click] = function(event)
		TransactionDashboard.on_gui_click(event)
		GatewayTransferGui.on_gui_click(event)
		TeleportGui.on_gui_click(event)
	end,

	[e.on_gui_closed] = function(event)
		TransactionDashboard.on_gui_closed(event)
		GatewayTransferGui.on_gui_closed(event)
		TeleportGui.on_gui_closed(event)
	end,

	[e.on_player_selected_area] = function(event)
		SelectionLab.handle(event, "copy")
	end,

	[e.on_player_alt_selected_area] = function(event)
		SelectionLab.handle(event, "paste")
	end,

	[e.on_player_reverse_selected_area] = function(event)
		SelectionLab.handle(event, "audit")
	end,

	[e.on_player_alt_reverse_selected_area] = function(event)
		SelectionLab.handle(event, "force")
	end,

}

if prototypes and prototypes.custom_input["selection-lab-undo"] then
	SurfaceExportModule.events["selection-lab-undo"] = function(event)
		SelectionLab.undo(event)
	end
end
if prototypes and prototypes.custom_input["selection-lab-redo"] then
	SurfaceExportModule.events["selection-lab-redo"] = function(event)
		SelectionLab.redo(event)
	end
end



return SurfaceExportModule
