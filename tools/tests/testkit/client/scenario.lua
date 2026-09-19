local run = require("run")
local Panel
local Policy
if run.scenario ~= "smoke" then
	Panel = require("modules/surface_export/interfaces/gui/instance-panel")
	Policy = require("modules/surface_export/core/planet-policy")
end

local function add_ships(count)
	storage.extra_ships = storage.extra_ships or {}
	for i = 1, count do
		local ship = assert(game.forces.player.create_space_platform{name = "Layout test " .. i,
			planet = "fulgora", starter_pack = "space-platform-starter-pack"})
		ship.apply_starter_pack(true)
		ship.paused = true
		storage.extra_ships[#storage.extra_ships + 1] = ship
	end
end

local function clear_extras()
	for _, ship in pairs(storage.extra_ships or {}) do if ship.valid then ship.destroy() end end
	storage.extra_ships = {}
end

script.on_init(function()
	if not Panel then return end
	storage.source_recovery_epoch = run.id
	storage.source_recovery_ready = true
	storage.source_recovery_surface_epochs = {}
	game.forces.player.research_all_technologies()
	assert(Policy.apply{version = 1, epoch = run.id, defaultPlanet = "fulgora",
		disabledPlanets = {"nauvis", "vulcanus"}, instanceName = "Fulgora instance"}.success)
	storage.ships = {}
	for _, name in ipairs({"Aurora", "Wayfarer", "Wayfarer"}) do
		local ship = assert(game.forces.player.create_space_platform{name = name, planet = "fulgora",
			starter_pack = "space-platform-starter-pack"})
		ship.apply_starter_pack(true)
		ship.space_location = "surfexp_gateway_hub"
		ship.paused = false
		ship.schedule = {current = 1, records = {{station = "surfexp_gateway_hub",
			wait_conditions = {{type = "time", ticks = 360000, compare_type = "and"}}}}}
		storage.source_recovery_surface_epochs[ship.surface.index] = run.id
		storage.ships[#storage.ships + 1] = ship
	end
end)

script.on_event(defines.events.on_tick, function()
	local player = game.connected_players[1]
	if not player or storage.finished then return end
	if not storage.started then
		if player.controller_type == defines.controllers.cutscene then player.exit_cutscene() end
		if Panel then
			assert(Policy.ensure_player(player, true))
			assert(player.enter_space_platform(storage.ships[1]))
			Panel.refresh_button(player)
			if run.scenario == "gui-anchors" then
				local roots = {}
				for _, name in ipairs({"left", "top", "screen", "relative"}) do
					local root = player.gui[name]
					roots[name] = {type = root.type, children = root.children_names, parent = root.parent and root.parent.name}
				end
				helpers.write_file("gui-roots.json", helpers.table_to_json(roots), false)
				for _, name in ipairs({"controller_gui", "additional_entity_info_gui", "space_platform_hub_gui"}) do
					player.gui.relative.add{type = "frame", caption = "ANCHOR: " .. name,
						anchor = {gui = defines.relative_gui_type[name], position = defines.relative_gui_position.bottom}}
				end
			end
		else
			player.gui.screen.add{type = "frame", caption = "Graphical client screenshot probe", name = "client_probe"}.auto_center = true
		end
		storage.started = game.tick
		storage.captures = {}
	end
	local elapsed = game.tick - storage.started
	if Panel then Panel.refresh(player) end
	local capture
	if run.scenario == "gui-anchors" then
		if elapsed == 75 then player.opened = storage.ships[1].hub end
		capture = ({[45] = "remote", [120] = "hub"})[elapsed]
	elseif Panel then
		if elapsed == 75 then add_ships(5) end
		if elapsed == 150 or elapsed == 300 then clear_extras() end
		if elapsed == 225 then add_ships(25) end
		if elapsed == 330 then Panel.open(player) end
		if elapsed == 380 then
			assert(Policy.apply{version = 1, epoch = run.id, defaultPlanet = "fulgora", disabledPlanets = {}, instanceName = "Fulgora instance"}.success)
			Panel.refresh_button(player)
		end
		if elapsed == 430 then for i = 2, 3 do storage.ships[i].paused = true end end
		capture = ({[45] = "small", [120] = "grown", [195] = "shrunk", [270] = "scrolling", [360] = "boarding", [420] = "no-planets", [460] = "no-boarding"})[elapsed]
	elseif elapsed == 45 then capture = "smoke" end
	if capture then
		local path = capture .. ".png"
		game.take_screenshot{player = player, path = path, show_gui = true,
			resolution = {run.width, run.height}}
		storage.captures[#storage.captures + 1] = path
		if Panel then
			local state = {panels = {}}
			for _, name in ipairs({"surfexp_instance_planets", "surfexp_instance_panel"}) do
				local frame = player.gui.screen[name]
				if frame then state.panels[name] = {location = frame.location, tags = frame.tags} end
			end
			helpers.write_file(capture .. "-positions.json", helpers.table_to_json(state), false)
		end
	end
	if elapsed == (run.scenario == "gui-anchors" and 150 or (Panel and 500 or 75)) then
		helpers.write_file("client-result.json", helpers.table_to_json({runId = run.id,
			scenario = run.scenario, status = "captured", engineVersion = script.active_mods.base,
			resolution = player.display_resolution, scale = player.display_scale, screenshots = storage.captures}), false)
		storage.finished = true
	end
end)

if Panel then
	local function record(event, entry)
		local player = game.get_player(event.player_index)
		entry.tick, entry.resolution, entry.scale = event.tick, player.display_resolution, player.display_scale
		helpers.write_file("location-events.jsonl", helpers.table_to_json(entry) .. "\n", true)
	end
	script.on_event(defines.events.on_gui_location_changed, function(event)
		record(event, {name = event.element.name, location = event.element.location, tags = event.element.tags})
	end)
	script.on_event(defines.events.on_player_display_resolution_changed, function(event)
		record(event, {event = "on_player_display_resolution_changed", old_resolution = event.old_resolution})
		Panel.refresh_viewport(event)
	end)
	script.on_event(defines.events.on_player_display_scale_changed, function(event)
		record(event, {event = "on_player_display_scale_changed", old_scale = event.old_scale})
		Panel.refresh_viewport(event)
	end)
	script.on_event(defines.events.on_gui_click, Panel.on_gui_click)
	script.on_event(defines.events.on_gui_closed, Panel.on_gui_closed)
	script.on_event(defines.events.on_player_controller_changed, function(event)
		Panel.refresh_visibility(game.get_player(event.player_index))
	end)
end
