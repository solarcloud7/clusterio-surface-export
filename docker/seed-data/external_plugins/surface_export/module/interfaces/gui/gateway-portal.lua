local Gateway = require("modules/surface_export/core/gateway")
local TeleportGui = require("modules/surface_export/interfaces/gui/teleport-gui")
local GatewayTransferGui = require("modules/surface_export/interfaces/gui/gateway-transfer")
local PassengerTransit = require("modules/surface_export/core/passenger-transit")

local Portal = {}

local GATEWAY_BUTTON = "surfexp_gateway_portal"
local TELEPORT_BUTTON = "surfexp_teleport_portal"
local GATEWAY_SPRITE = "space-location/surfexp_gateway_hub"

local function parked(player)
	local surface = game.get_surface(player.physical_surface_index)
	local platform = surface and surface.platform
	local gateway_name = platform and Gateway.parked_at_gateway(platform)
	if not gateway_name then return nil end
	local cfg = Gateway.get_gateway_config(gateway_name)
	if not (cfg and cfg.targets and #cfg.targets > 0) then return nil end
	return platform, gateway_name
end

local function show(player, name, wanted, sprite, fallback, tooltip)
	local button = player.gui.top[name]
	if not wanted then
		if button then button.destroy() end
	elseif not button then
		player.gui.top.add{type = "sprite-button", name = name, style = "mod_gui_button", tooltip = tooltip,
			sprite = helpers.is_valid_sprite_path(sprite) and sprite or fallback}
	end
end

function Portal.refresh(player)
	if not (player and player.valid) then return end
	show(player, GATEWAY_BUTTON, PassengerTransit.owns(player) or parked(player) ~= nil, GATEWAY_SPRITE, "entity/space-platform-hub",
		"Gateway: choose where this platform goes.")
	show(player, TELEPORT_BUTTON, TeleportGui.is_allowed(player), TeleportGui.ICON, "utility/character_running_speed_modifier_icon",
		"Teleport: connect to another instance.")
end

function Portal.on_gui_click(event)
	local element = event.element
	if not (element and element.valid) then return end
	local name = element.name
	if name ~= GATEWAY_BUTTON and name ~= TELEPORT_BUTTON then return end
	local player = game.get_player(event.player_index)
	if not player then return end
	if name == GATEWAY_BUTTON then
		if PassengerTransit.owns(player) then
			PassengerTransit.toggle_window(player)
		elseif GatewayTransferGui.is_open(player) then
			GatewayTransferGui.close(player)
		else
			local platform, gateway_name = parked(player)
			if platform then GatewayTransferGui.open(player, platform, gateway_name) end
		end
	elseif TeleportGui.is_open(player) then
		TeleportGui.close(player)
	elseif TeleportGui.is_allowed(player) then
		TeleportGui.request_roster()
		TeleportGui.open(player)
	end
	Portal.refresh(player)
end

return Portal
