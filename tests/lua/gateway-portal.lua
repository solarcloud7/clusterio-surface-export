local root = "docker/seed-data/external_plugins/surface_export/module/"
local BUTTON = "surfexp_gateway_portal"

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
local dialog_open = false

local env = setmetatable({
	game = {get_player = function() return player end, get_surface = function(index) return index == 70 and surface or nil end},
	helpers = {is_valid_sprite_path = function() return true end},
}, {__index = _G})
env.require = function(name)
	if name:find("teleport-gui", 1, true) then
		return {is_allowed = function() return allowed end,
			request_roster = function() calls[#calls + 1] = "roster" end,
			open = function() calls[#calls + 1] = "teleport" end}
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
assert(not player.gui.top[BUTTON], "a player away from a gateway without teleport permission should not see the portal")
allowed = true
portal.refresh(player)
local button = player.gui.top[BUTTON]
assert(button and button.sprite == "space-location/surfexp_gateway_hub" and button.style == "mod_gui_button",
	"a player allowed to teleport should see the gateway portal")
assert(button.tooltip:find("Teleport", 1, true) and not button.tooltip:find("Gateway", 1, true))
allowed = false
portal.refresh(player)
assert(not player.gui.top[BUTTON], "losing teleport permission away from a gateway should remove the portal")
print("PASS the portal is shown to players allowed to teleport")

parked = "surfexp_gateway_hub"
portal.refresh(player)
button = player.gui.top[BUTTON]
assert(button and button.tooltip:find("Gateway", 1, true), "a player aboard a platform parked at a gateway should see the portal")
targets = {}
portal.refresh(player)
assert(not player.gui.top[BUTTON], "a gateway without destinations should not show the portal")
targets = {{instanceId = 2, online = true}}
player.physical_surface_index = 71
portal.refresh(player)
assert(not player.gui.top[BUTTON], "a player not aboard the parked platform should not see the portal")
player.physical_surface_index = 70
print("PASS the portal is shown aboard a platform parked at a gateway with destinations")

portal.refresh(player)
portal.on_gui_click{player_index = 1, element = player.gui.top[BUTTON]}
assert(calls[#calls] == "gateway:7:surfexp_gateway_hub" and dialog_open, "clicking at a gateway should open the gateway dialog")
portal.on_gui_click{player_index = 1, element = player.gui.top[BUTTON]}
assert(calls[#calls] == "close" and not dialog_open, "clicking again should close the gateway dialog")
parked, allowed = nil, true
portal.on_gui_click{player_index = 1, element = player.gui.top[BUTTON]}
assert(calls[#calls - 1] == "roster" and calls[#calls] == "teleport", "clicking away from a gateway should open the teleport window")
local before = #calls
allowed = false
portal.on_gui_click{player_index = 1, element = player.gui.top[BUTTON]}
assert(#calls == before, "a player without permission away from a gateway should not get the teleport window")
assert(not player.gui.top[BUTTON], "the click should remove a portal the player can no longer use")
print("PASS clicking the portal opens the gateway dialog at a gateway and the teleport window elsewhere")
