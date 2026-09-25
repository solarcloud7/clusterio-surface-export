local Gateway = require("modules/surface_export/core/gateway")
local TeleportGui = require("modules/surface_export/interfaces/gui/teleport-gui")
local GatewayTransferGui = require("modules/surface_export/interfaces/gui/gateway-transfer")

local Portal = {}

local BUTTON = "surfexp_gateway_portal"
local SPRITE = "space-location/surfexp_gateway_hub"
local FALLBACK_SPRITE = "entity/space-platform-hub"

local function parked(player)
	local surface = game.get_surface(player.physical_surface_index)
	local platform = surface and surface.platform
	local gateway_name = platform and Gateway.parked_at_gateway(platform)
	if not gateway_name then return nil end
	local cfg = Gateway.get_gateway_config(gateway_name)
	if not (cfg and cfg.targets and #cfg.targets > 0) then return nil end
	return platform, gateway_name
end

local function tooltip(at_gateway, allowed)
	if at_gateway and allowed then return "Gateway: choose where this platform goes, or teleport to another instance." end
	if at_gateway then return "Gateway: choose where this platform goes." end
	return "Teleport: connect to another instance."
end

function Portal.refresh(player)
	if not (player and player.valid) then return end
	local at_gateway = parked(player) ~= nil
	local allowed = TeleportGui.is_allowed(player)
	local button = player.gui.top[BUTTON]
	if not (at_gateway or allowed) then
		if button then button.destroy() end
		return
	end
	local tip = tooltip(at_gateway, allowed)
	if not button then
		player.gui.top.add{type = "sprite-button", name = BUTTON, style = "mod_gui_button", tooltip = tip,
			sprite = helpers.is_valid_sprite_path(SPRITE) and SPRITE or FALLBACK_SPRITE}
	elseif button.tooltip ~= tip then
		button.tooltip = tip
	end
end

function Portal.on_gui_click(event)
	local element = event.element
	if not (element and element.valid and element.name == BUTTON) then return end
	local player = game.get_player(event.player_index)
	if not player then return end
	if GatewayTransferGui.is_open(player) then
		GatewayTransferGui.close(player)
		return
	end
	local platform, gateway_name = parked(player)
	if platform then
		GatewayTransferGui.open(player, platform, gateway_name)
	elseif TeleportGui.is_allowed(player) then
		TeleportGui.request_roster()
		TeleportGui.open(player)
	end
	Portal.refresh(player)
end

return Portal
