local root = "docker/seed-data/external_plugins/surface_export/module/"
local FRAME = "surface_export_teleport"

local counter = 0
local function gui(parent, values)
	local element = values or {}
	counter = counter + 1
	element.valid, element.index, element.style = true, counter, {}
	element.tags = element.tags or {}
	element.children = {}
	element.enabled = element.enabled ~= false
	element.add = function(spec)
		local child = gui(element, spec)
		element.children[#element.children + 1] = child
		if spec.name then element[spec.name] = child end
		return child
	end
	element.destroy = function()
		element.valid = false
		if parent and element.name then parent[element.name] = nil end
	end
	return element
end
local function find(element, predicate)
	for _, child in ipairs(element.children) do
		if predicate(child) then return child end
		local nested = find(child, predicate)
		if nested then return nested end
	end
end
local function named(element, name) return find(element, function(child) return child.name == name end) end
local function captioned(element, text)
	return find(element, function(child) return type(child.caption) == "string" and child.caption:find(text, 1, true) ~= nil end)
end

local connects, printed, logged, requests = {}, {}, {}, 0
local player = {index = 1, name = "tester", valid = true, admin = true, gui = {screen = gui()}}
player.print = function(message) printed[#printed + 1] = message end
player.connect_to_server = function(options) connects[#connects + 1] = options end

local env = setmetatable({
	storage = {},
	game = {get_player = function() return player end, permissions = {}},
	helpers = {is_valid_sprite_path = function() return true end},
	log = function(message) logged[#logged + 1] = message end,
}, {__index = _G})
env.require = function(name)
	if name:find("clusterio/api", 1, true) then
		return {send_json = function(kind) if kind == "surface_teleport_roster_request" then requests = requests + 1 end end}
	end
	error("unexpected require " .. name)
end
local teleport = assert(loadfile(root .. "interfaces/gui/teleport-gui.lua", "t", env))()

teleport.open(player)
local frame = player.gui.screen[FRAME]
assert(frame and player.opened == frame and captioned(frame, "Fetching"), "an empty roster should say it is being fetched")
assert(not named(frame, "surface_export_teleport_connect").enabled, "Connect needs a destination")
print("PASS the window waits for the roster before offering Connect")

env.storage.teleport_roster = {instances = {
	{instanceId = 1, name = "Here", address = "host:1", online = true, self = true},
	{instanceId = 3, name = "Zed", address = "host:3", online = false},
	{instanceId = 2, name = "Two", address = "host:2", online = true},
	{instanceId = 4, name = "Four", address = "host:4", online = true},
}}
teleport.refresh_all()
frame = player.gui.screen[FRAME]
assert(not captioned(frame, "Here"), "the current instance should not be listed")
local four, two, zed = named(frame, "surface_export_teleport_target_1"), named(frame, "surface_export_teleport_target_2"), named(frame, "surface_export_teleport_target_3")
assert(four.caption == "Four" and two.caption == "Two" and zed.caption == "Zed", "online instances should be listed first, by name")
assert(four.state and not zed.enabled and captioned(frame, "Offline"), "the first online instance is preselected and offline ones are disabled")
assert(named(frame, "surface_export_teleport_connect").enabled)
print("PASS the roster lists other instances, online first, with offline ones disabled")

teleport.on_gui_click{player_index = 1, element = two}
frame = player.gui.screen[FRAME]
assert(named(frame, "surface_export_teleport_target_2").state and not named(frame, "surface_export_teleport_target_1").state)
env.storage.teleport_roster.instances[3].online = false
teleport.refresh_all()
frame = player.gui.screen[FRAME]
assert(named(frame, "surface_export_teleport_target_1").state and named(frame, "surface_export_teleport_target_1").caption == "Four",
	"a selection that went offline should fall back to an online instance")
env.storage.teleport_roster.instances[3].online = true
teleport.refresh_all()
teleport.on_gui_click{player_index = 1, element = named(player.gui.screen[FRAME], "surface_export_teleport_target_2")}
teleport.on_gui_click{player_index = 1, element = named(player.gui.screen[FRAME], "surface_export_teleport_refresh")}
assert(requests == 1 and player.gui.screen[FRAME], "Refresh should request the roster and keep the window")
print("PASS choosing and refreshing keeps a valid selection")

teleport.on_gui_click{player_index = 1, element = named(player.gui.screen[FRAME], "surface_export_teleport_connect")}
assert(#connects == 1 and connects[1].address == "host:2" and connects[1].name == "Two", "Connect should prompt for the chosen instance")
assert(not player.gui.screen[FRAME] and not env.storage.surface_export_teleport_guis[1], "Connect should close the window")
assert(#printed == 0, "the connect prompt is the player's feedback; nothing should be printed to chat")
assert(#logged == 1 and logged[1]:find("tester", 1, true) and logged[1]:find("Two (host:2)", 1, true),
	"the connect prompt should be logged with the player and destination")
print("PASS Connect sends the connect prompt for the chosen instance, logs it and closes")

teleport.open(player)
player.admin = false
teleport.on_gui_click{player_index = 1, element = named(player.gui.screen[FRAME], "surface_export_teleport_connect")}
assert(#connects == 1 and not player.gui.screen[FRAME], "a player who lost permission should not be connected")
player.admin = true
teleport.open(player)
assert(teleport.is_open(player))
teleport.on_gui_click{player_index = 1, element = named(player.gui.screen[FRAME], "surface_export_teleport_cancel")}
assert(not teleport.is_open(player), "Close should close the window")
teleport.open(player)
teleport.on_gui_closed{player_index = 1, element = player.gui.screen[FRAME]}
assert(not teleport.is_open(player) and not env.storage.surface_export_teleport_guis[1], "Escape should close the window")
print("PASS permission loss, Close and Escape close the window without connecting")
