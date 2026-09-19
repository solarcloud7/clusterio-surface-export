local root = "docker/seed-data/external_plugins/surface_export/module/"
local force = {name = "player", platforms = {}}
local function platform(index)
	local p = {valid = true, index = index, name = "same name", uid = "uid:" .. index, force = force, scheduled_for_deletion = 0,
		hub = {valid = true}, surface = {valid = true, index = index}, space_location = {name = "nauvis"}, paused = false}
	p.surface.platform = p
	force.platforms[index] = p
	return p
end
local source, target = platform(1), platform(2)
local env = setmetatable({storage = {source_recovery_ready = true}, settings = {global = {["surfexp-platform-boarding"] = {value = true}}},
	game = {forces = {player = force}, get_surface = function(index) return force.platforms[index].surface end}}, {__index = _G})
env.require = function(name)
	if name:find("platform-identity", 1, true) then return function(p) return p.uid end end
	assert(name:find("surface-lock", 1, true))
	return {is_locked = function(index) return force.platforms[index].locked end,
		destination_hold_owns_surface = function(_, p) return p.held end}
end
local boarding = assert(loadfile(root .. "core/platform-boarding.lua", "t", env))()
local possessions = {}
local calls = 0
local player = {force = force, physical_surface_index = 1, possessions = possessions, enter_space_platform = function(p)
	assert(p == target); calls = calls + 1; return true
end}
local choice = boarding.targets(player)[1]
assert(choice and choice.uid == target.uid and boarding.board(player, choice))
assert(calls == 1 and player.possessions == possessions)
for _, p in ipairs({source, target}) do
	for _, field in ipairs({"paused", "hidden", "locked", "held", "space_connection"}) do
		p[field] = true
		assert(not boarding.board(player, choice), field .. " admitted boarding")
		p[field] = nil
	end
	local uid = p.uid; p.uid = "replacement"
	assert(not boarding.board(player, choice), "replacement platform admitted")
	p.uid = uid
end
target.space_location.name = "fulgora"
assert(not boarding.board(player, choice))
target.space_location.name = "nauvis"
env.storage.source_recovery_ready = false
assert(not boarding.board(player, choice))
env.storage.source_recovery_ready = true
env.settings.global["surfexp-platform-boarding"].value = false
assert(not boarding.board(player, choice))
assert(calls == 1, "refused requests reached player movement")
print("PASS boarding checks both platforms, location, saved identity, map setting and recovery gate before movement")

env.settings.global["surfexp-platform-boarding"].value = true
local seat_exits = 0
local seated_player = {force = force, physical_surface_index = source.index, hub = source.hub, possessions = possessions}
seated_player.leave_space_platform = function()
	seat_exits = seat_exits + 1
	seated_player.hub = nil
end
seated_player.enter_space_platform = function(p)
	if seated_player.hub then return false end
	seated_player.hub = p.hub
	seated_player.physical_surface_index = p.index
	return true
end
local function assert_seated_refusal()
	assert(not boarding.board(seated_player, choice))
	assert(seat_exits == 0 and seated_player.hub == source.hub, "refusal ejected the passenger")
end
for _, p in ipairs({source, target}) do
	for _, field in ipairs({"paused", "hidden", "locked", "held", "space_connection"}) do
		local previous = p[field]
		p[field] = true
		assert_seated_refusal()
		p[field] = previous
	end
	local uid = p.uid
	p.uid = "replacement"
	assert_seated_refusal()
	p.uid = uid
end
target.space_location.name = "fulgora"
assert_seated_refusal()
target.space_location.name = "nauvis"
seated_player.force = {name = "different force"}
assert_seated_refusal()
seated_player.force = force
env.storage.source_recovery_ready = false
assert_seated_refusal()
env.storage.source_recovery_ready = true
env.settings.global["surfexp-platform-boarding"].value = false
assert_seated_refusal()
env.settings.global["surfexp-platform-boarding"].value = true
assert(boarding.board(seated_player, choice), "seated passenger cannot board another platform")
assert(seat_exits == 1 and seated_player.physical_surface_index == target.index and seated_player.hub == target.hub)
assert(seated_player.possessions == possessions)
seated_player.physical_surface_index, seated_player.hub = source.index, source.hub
seated_player.enter_space_platform = function() return false end
assert(not boarding.board(seated_player, choice))
assert(seated_player.physical_surface_index == source.index and seated_player.possessions == possessions)
print("PASS seated boarding leaves the source hub only after admission and preserves source location when the engine refuses")

local counter = 0
local function gui(parent, values)
	local element = values or {}
	counter = counter + 1
	element.valid, element.index, element.style = true, counter, {}
	element.tags = element.tags or {}
	element.children = {}
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
local ui_player = {index = 1, gui = {top = gui(), left = gui(), screen = gui()},
	display_scale = 1, display_resolution = {width = 1600, height = 1000}, force = force, controller_type = 2}
local ui_calls = 0
local second_choice = {name = choice.name, uid = "another-target", source_uid = choice.source_uid}
local ui_targets = {choice, second_choice}
local ui_env = setmetatable({storage = {surface_export_planet_policy = {default_planet = "nauvis", disabled = {}, instance_name = "One"}},
	prototypes = {space_location = {nauvis = {localised_name = "Nauvis"}}},
	defines = {controllers = {remote = 2}},
	game = {tick = 100, planets = {}, get_player = function() return ui_player end},
	require = function()
		return {source = function() return source end, enabled = function() return true end, targets = function() return ui_targets end, board = function(_, selected)
			assert(selected.uid == second_choice.uid and selected.source_uid == choice.source_uid)
			ui_calls = ui_calls + 1
			return true
		end}
	end}, {__index = _G})
local panel_path = root .. "interfaces/gui/instance-panel.lua"
local panel = assert(loadfile(panel_path, "t", ui_env))()
panel.open(ui_player)
assert(ui_env.storage.surface_export_boarding_selections[1][1].uid == choice.uid)
local joined_panel = assert(loadfile(panel_path, "t", ui_env))()
joined_panel.on_gui_click{player_index = 1, element = {valid = true, name = "surfexp_instance_board", tags = {choice = 2}}}
assert(ui_calls == 1, "panel reload lost the selected persistent identity")
assert(ui_env.storage.surface_export_boarding_selections[1] == nil)
print("PASS boarding rows preserve distinct identities for matching names across module reload")

panel.refresh_planets(ui_player)
local planets_name, boarding_name = "surfexp_instance_planets", "surfexp_instance_panel"
local function assert_position(name, x, y)
	local location = ui_player.gui.screen[name].location
	assert(location[1] == x and location[2] == y, name .. " at " .. location[1] .. "," .. location[2] .. " expected " .. x .. "," .. y)
end
assert(ui_player.gui.screen[planets_name] and ui_player.gui.screen[boarding_name] and not ui_player.opened)
assert_position(planets_name, 10, 262)
assert_position(boarding_name, 1334, 604)
platform(3)
panel.refresh_position(ui_player)
assert_position(planets_name, 10, 290)
force.platforms[3].scheduled_for_deletion = 60
panel.refresh_position(ui_player)
assert_position(planets_name, 10, 262)
force.platforms[3] = nil
ui_player.display_scale = 1.5
ui_player.display_resolution = {width = 800, height = 600}
joined_panel.refresh_viewport{player_index = 1, tick = 5}
for _, name in ipairs({planets_name, boarding_name}) do
	local frame = ui_player.gui.screen[name]
	assert(frame.location[1] >= 0 and frame.location[1] <= 800 - 256 * 1.5)
	assert(frame.location[2] >= 0 and frame.location[2] < 600)
end
ui_player.display_scale, ui_player.display_resolution = 1, {width = 1600, height = 1000}
joined_panel.refresh_viewport{player_index = 1, tick = 6}
assert_position(boarding_name, 1334, 604)
assert_position(planets_name, 10, 262)
ui_player.controller_type = 1
joined_panel.refresh_visibility(ui_player)
assert(not ui_player.gui.screen[planets_name].visible and not ui_player.gui.screen[boarding_name].visible)
print("PASS panels follow the estimated sidebar height, skip platforms pending deletion, clamp to the viewport and hide outside Remote View")

local function contains(element, kind, caption)
	for _, child in ipairs(element.children) do
		if (child.type == kind and child.caption == caption) or contains(child, kind, caption) then return true end
	end
	return false
end
ui_player.controller_type = 2
ui_targets = {}
joined_panel.open(ui_player)
local empty = ui_player.gui.screen[boarding_name]
assert(contains(empty, "label", "None") and not contains(empty, "button", "Board"), "zero eligible platforms should render None without Board buttons")
ui_targets = {choice, second_choice}
joined_panel.open(ui_player)
local listed = ui_player.gui.screen[boarding_name]
assert(contains(listed, "button", "Board") and not contains(listed, "label", "None"), "eligible platforms should render Board buttons without None")
print("PASS the Boarding panel renders None with zero eligible platforms and Board buttons otherwise")
