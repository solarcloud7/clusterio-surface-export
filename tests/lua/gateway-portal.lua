local root = "docker/seed-data/external_plugins/surface_export/module/"
local GATEWAY = "surfexp_gateway_portal"
local TELEPORT = "surfexp_teleport_portal"

local function top()
	local element = {}
	element.add = function(spec)
		local child = {valid = true, name = spec.name, sprite = spec.sprite, style = spec.style, tooltip = spec.tooltip}
		child.destroy = function() child.valid = false; element[spec.name] = nil end
		element[spec.name] = child
		return child
	end
	return element
end

local parked, targets, allowed = nil, {{instanceId = 2, online = true}}, false
local platform = {valid = true, index = 7}
local surface = {platform = platform}
local player = {index = 1, valid = true, physical_surface_index = 70, gui = {top = top()}}
local calls = {}
local dialog_open, teleport_open = false, false

local env = setmetatable({
	game = {get_player = function() return player end, get_surface = function(index) return index == 70 and surface or nil end},
	helpers = {is_valid_sprite_path = function() return true end},
}, {__index = _G})
env.require = function(name)
	if name:find("teleport-gui", 1, true) then
		return {ICON = "space-location/surfexp_gateway_3", is_allowed = function() return allowed end,
			is_open = function() return teleport_open end,
			close = function() teleport_open = false; calls[#calls + 1] = "teleport-close" end,
			request_roster = function() calls[#calls + 1] = "roster" end,
			open = function() teleport_open = true; calls[#calls + 1] = "teleport" end}
	end
	if name:find("gateway-transfer", 1, true) then
		return {is_open = function() return dialog_open end,
			close = function() dialog_open = false; calls[#calls + 1] = "close" end,
			open = function(_, p, gateway) dialog_open = true; calls[#calls + 1] = "gateway:" .. p.index .. ":" .. gateway; return true end}
	end
	return {
		parked_at_gateway = function() return parked end,
		get_gateway_config = function() return {targets = targets} end,
	}
end
local portal = assert(loadfile(root .. "interfaces/gui/gateway-portal.lua", "t", env))()

portal.refresh(player)
assert(not player.gui.top[GATEWAY] and not player.gui.top[TELEPORT], "a player away from a gateway without teleport permission should see neither button")
allowed = true
portal.refresh(player)
local teleport = player.gui.top[TELEPORT]
assert(teleport and teleport.sprite == "space-location/surfexp_gateway_3" and teleport.style == "mod_gui_button",
	"a player allowed to teleport should see the orange teleport button")
assert(not player.gui.top[GATEWAY], "the gateway button should need a parked platform")
allowed = false
portal.refresh(player)
assert(not player.gui.top[TELEPORT], "losing teleport permission should remove the teleport button")
print("PASS the orange teleport button is shown only to players allowed to teleport")

parked = "surfexp_gateway_hub"
portal.refresh(player)
local gateway = player.gui.top[GATEWAY]
assert(gateway and gateway.sprite == "space-location/surfexp_gateway_hub" and not player.gui.top[TELEPORT],
	"a player aboard a platform parked at a gateway should see only the gateway button")
targets = {}
portal.refresh(player)
assert(not player.gui.top[GATEWAY], "a gateway without destinations should not show the gateway button")
targets = {{instanceId = 2, online = true}}
player.physical_surface_index = 71
portal.refresh(player)
assert(not player.gui.top[GATEWAY], "a player not aboard the parked platform should not see the gateway button")
player.physical_surface_index = 70
print("PASS the gateway button is shown aboard a platform parked at a gateway with destinations")

allowed = true
portal.refresh(player)
portal.on_gui_click{player_index = 1, element = player.gui.top[GATEWAY]}
assert(calls[#calls] == "gateway:7:surfexp_gateway_hub" and dialog_open, "the gateway button should open the gateway dialog")
portal.on_gui_click{player_index = 1, element = player.gui.top[GATEWAY]}
assert(calls[#calls] == "close" and not dialog_open, "clicking again should close the gateway dialog")
portal.on_gui_click{player_index = 1, element = player.gui.top[TELEPORT]}
assert(calls[#calls - 1] == "roster" and calls[#calls] == "teleport" and not dialog_open,
	"the teleport button should open the teleport window, not the gateway dialog")
portal.on_gui_click{player_index = 1, element = player.gui.top[TELEPORT]}
assert(calls[#calls] == "teleport-close" and not teleport_open, "clicking again should close the teleport window")
local before = #calls
allowed = false
portal.on_gui_click{player_index = 1, element = player.gui.top[TELEPORT]}
assert(#calls == before and not player.gui.top[TELEPORT], "a player who lost permission should not get the window and loses the button")
print("PASS each button opens and closes its own window")
