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
local calls = 0
local player = {force = force, physical_surface_index = 1, enter_space_platform = function(p)
	assert(p == target); calls = calls + 1; return true
end}
local choice = boarding.targets(player)[1]
assert(choice and choice.uid == target.uid and boarding.board(player, choice))
assert(calls == 1)
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
local seated_player = {force = force, physical_surface_index = source.index, hub = source.hub}
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
seated_player.physical_surface_index, seated_player.hub = source.index, source.hub
seated_player.enter_space_platform = function() return false end
assert(not boarding.board(seated_player, choice))
assert(seated_player.physical_surface_index == source.index)
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
target.hub.position = {x = 3, y = 4}
local ui_player = {index = 1, gui = {top = gui(), left = gui(), screen = gui()},
	display_scale = 1, display_resolution = {width = 1600, height = 1000}, force = force, controller_type = 2}
local controller_moves = {}
ui_player.set_controller = function(spec) controller_moves[#controller_moves + 1] = spec end
local ui_calls = 0
local second_choice = {name = choice.name, uid = "another-target", source_uid = choice.source_uid, force = "player", index = target.index}
local ui_targets = {choice, second_choice}
local ui_env = setmetatable({storage = {surface_export_planet_policy = {default_planet = "nauvis", disabled = {}, instance_name = "One"}},
	prototypes = {space_location = {nauvis = {localised_name = "Nauvis"}}},
	defines = {controllers = {remote = 2}},
	game = {tick = 100, planets = {}, forces = {player = force}, get_player = function() return ui_player end},
	require = function()
		return {source = function() return source end, enabled = function() return true end, targets = function() return ui_targets end, board = function(_, selected)
			assert(selected.uid == second_choice.uid and selected.source_uid == choice.source_uid)
			ui_calls = ui_calls + 1
			return true
		end}
	end}, {__index = _G})
local panel_path = root .. "interfaces/gui/instance-panel.lua"
local panel = assert(loadfile(panel_path, "t", ui_env))()
local planets_name, boarding_section = "surfexp_instance_planets", "surfexp_boarding_section"
ui_player.gui.screen.add{type = "frame", name = "surfexp_instance_panel"}
panel.refresh_planets(ui_player)
local frame = ui_player.gui.screen[planets_name]
assert(frame and frame[boarding_section], "boarding targets should add the Boarding section to the instance panel")
assert(not ui_player.gui.screen.surfexp_instance_panel, "the retired right-hand Boarding frame should be removed")
assert(ui_env.storage.surface_export_boarding_selections[1][1].uid == choice.uid)
local joined_panel = assert(loadfile(panel_path, "t", ui_env))()
joined_panel.on_gui_click{player_index = 1, element = {valid = true, name = "surfexp_instance_board", tags = {choice = 2}}}
assert(ui_calls == 1, "panel reload lost the selected persistent identity")
assert(#controller_moves == 1 and controller_moves[1].type == 2 and controller_moves[1].surface == target.surface
	and controller_moves[1].position == target.hub.position, "boarding should move the remote view to the target hub")
assert(ui_env.storage.surface_export_boarding_selections[1][2].uid == second_choice.uid, "the Boarding list should be rebuilt after boarding")
print("PASS boarding rows preserve distinct identities across module reload and boarding moves the remote view to the target hub")

local function assert_position(name, x, y)
	local location = ui_player.gui.screen[name].location
	assert(location[1] == x and location[2] == y, name .. " at " .. location[1] .. "," .. location[2] .. " expected " .. x .. "," .. y)
end
frame = ui_player.gui.screen[planets_name]
assert(frame.visible and not frame.surfexp_planet_section.visible and not ui_player.gui.screen.surfexp_instance_title.visible,
	"with the toggle off only the Boarding section should show")
assert_position(planets_name, 13, 260)
joined_panel.on_gui_click{player_index = 1, element = {valid = true, name = "surfexp_instance_toggle_planets"}}
assert(frame.surfexp_planet_section.visible and ui_player.gui.screen.surfexp_instance_title.visible)
local saved_platforms = force.platforms
local saved_unlocked, saved_hidden = force.is_space_platforms_unlocked, force.get_surface_hidden
force.platforms = {}
force.is_space_platforms_unlocked = function() return false end
force.get_surface_hidden = function() return false end
ui_env.game.planets.nauvis = {surface = {}}
panel.refresh_position(ui_player)
assert_position(planets_name, 13, 172)
force.platforms = saved_platforms
force.is_space_platforms_unlocked, force.get_surface_hidden = saved_unlocked, saved_hidden
ui_env.game.planets.nauvis = nil
platform(3)
panel.refresh_position(ui_player)
assert_position(planets_name, 13, 288)
force.platforms[3].scheduled_for_deletion = 60
panel.refresh_position(ui_player)
assert_position(planets_name, 13, 260)
force.platforms[3] = nil
ui_player.display_scale = 1.5
ui_player.display_resolution = {width = 800, height = 600}
joined_panel.refresh_viewport{player_index = 1, tick = 5}
assert(frame.location[1] >= 0 and frame.location[1] <= 800 - 255 * 1.5)
assert(frame.location[2] >= 0 and frame.location[2] < 600)
ui_player.display_scale, ui_player.display_resolution = 1.5, {width = 1280, height = 900}
joined_panel.refresh_viewport{player_index = 1, tick = 6}
assert_position(planets_name, 19, 389)
ui_player.display_scale, ui_player.display_resolution = 1, {width = 1600, height = 1000}
joined_panel.refresh_viewport{player_index = 1, tick = 7}
assert_position(planets_name, 13, 260)
ui_player.controller_type = 1
joined_panel.refresh_visibility(ui_player)
assert(not frame.visible, "the instance panel should hide outside Remote View")
print("PASS the instance panel follows the estimated sidebar height, skips platforms pending deletion, clamps to the viewport and hides outside Remote View")

local function contains(element, kind, caption)
	for _, child in ipairs(element.children) do
		if (child.type == kind and child.caption == caption) or contains(child, kind, caption) then return true end
	end
	return false
end
ui_player.controller_type = 2
ui_targets = {}
joined_panel.refresh_visibility(ui_player)
assert(not frame[boarding_section], "zero eligible platforms should remove the Boarding section")
ui_targets = {choice, second_choice}
joined_panel.refresh_visibility(ui_player)
assert(frame[boarding_section] and contains(frame[boarding_section], "button", "Board"), "eligible platforms should render Board buttons")
assert(contains(frame.surfexp_planet_section, "label", "None"), "no unavailable planets should render None")
ui_env.storage.surface_export_planet_policy.disabled = {nauvis = true}
joined_panel.refresh_planets(ui_player)
frame = ui_player.gui.screen[planets_name]
assert(not contains(frame.surfexp_planet_section, "label", "None"), "an unavailable planet should replace None")
ui_env.storage.surface_export_planet_policy.disabled = {}
print("PASS the Boarding section appears only with eligible platforms; Unavailable Planets renders None only when empty")
