local Boarding = require("modules/surface_export/core/platform-boarding")
local Panel = {}
local FRAME = "surfexp_instance_panel"
local OPEN = "surfexp_instance_open"
local CLOSE = "surfexp_instance_close"
local BOARD = "surfexp_instance_board"
local PLANETS = "surfexp_instance_planets"
local TITLE = "surfexp_instance_title"
local TOGGLE = "surfexp_instance_toggle_planets"
local WIDTH = 256
local MARGIN = 11
local ROW = 36
local VISIBLE_ROWS = 8
local DEFAULT_INFO = "Players arrive here when this instance needs to return them to a planet, including after their platform transfers to another server."
local UNAVAILABLE_INFO = "These planets are unavailable on this instance. They are hidden from the surface list and cannot be selected for new journeys."
local BOARDING_INFO = "Board another platform stopped at this location on this instance. Both ships must be enabled, at the same location and not transferring."

local function estimate_left(player)
	local rows, platforms = 0, 0
	for _, planet in pairs(game.planets) do
		if planet.surface and not player.force.get_surface_hidden(planet.surface) then rows = rows + 1 end
	end
	for _, platform in pairs(player.force.platforms) do
		if platform.valid and not platform.hidden and platform.scheduled_for_deletion == 0 then platforms = platforms + 1 end
	end
	local platform_controls = (platforms > 0 or player.force.is_space_platforms_unlocked()) and 60 or 0
	return 40 + math.min(108 + platform_controls + 28 * (rows + platforms), player.display_resolution.height / player.display_scale * 0.6)
end

local function place(player, frame, x, y)
	local scale = player.display_scale
	local tags = frame.tags
	x = math.floor(math.max(0, math.min(x * scale, player.display_resolution.width - WIDTH * scale)) + 0.5)
	y = math.floor(math.max(0, math.min(y * scale, player.display_resolution.height - (tags.panel_height or 160) * scale)) + 0.5)
	if tags.placed_x == x and tags.placed_y == y then return end
	tags.placed_x, tags.placed_y = x, y
	frame.tags = tags
	frame.location = {x, y}
end

function Panel.refresh_position(player)
	local title = player.gui.screen[TITLE]
	local scale = player.display_scale
	if title then
		local width = math.min(320, player.display_resolution.width / scale)
		title.style.width = width
		title.location = {math.floor((player.display_resolution.width - width * scale) / 2), math.floor(40 * scale)}
	end
	local planets = player.gui.screen[PLANETS]
	if planets then place(player, planets, MARGIN + 2 / scale, estimate_left(player) + 2 / scale) end
	local boarding = player.gui.screen[FRAME]
	if boarding then place(player, boarding, (player.display_resolution.width - math.floor(MARGIN * scale + 0.5)) / scale - WIDTH, 604) end
end

local function boarding_visible(player)
	if player.controller_type ~= defines.controllers.remote or player.selected then return false end
	local source = Boarding.source(player)
	return source ~= nil and source.valid and #Boarding.targets(player) > 0
end

function Panel.refresh_viewport(event)
	local player = game.get_player(event.player_index)
	if player then Panel.refresh_position(player) end
end

function Panel.refresh_visibility(player)
	local remote_view = player.controller_type == defines.controllers.remote
	local shown = remote_view and (storage.surface_export_planet_panel_visible or {})[player.index] == true
	local frame = player.gui.screen[PLANETS]
	if frame then frame.visible = shown end
	local title = player.gui.screen[TITLE]
	if title then title.visible = shown end
	local toggle = player.gui.top[TOGGLE]
	if toggle then toggle.visible = remote_view; toggle.toggled = shown end
	local boarding = player.gui.screen[FRAME]
	local visible = boarding_visible(player)
	if boarding then boarding.visible = visible
	elseif visible and storage.surface_export_planet_policy then Panel.open(player) end
end

local function section_heading(parent, caption, tooltip)
	local row = parent.add{type = "flow", direction = "horizontal"}
	row.style.vertical_align = "center"
	row.add{type = "label", caption = caption, style = "bold_label", tooltip = tooltip}
	return row
end

local function inset(parent)
	local frame = parent.add{type = "frame", style = "inside_shallow_frame_with_padding", direction = "vertical"}
	frame.style.horizontally_stretchable = true
	return frame
end

local function planet_row(parent, name, disabled)
	local proto = prototypes.space_location[name]
	local row = parent.add{type = "flow", direction = "horizontal"}
	row.style.height = 32
	row.style.vertical_align = "center"
	row.style.horizontal_spacing = 6
	local icon = row.add{type = "flow", direction = "horizontal"}
	icon.style.horizontal_spacing = 0
	local planet = icon.add{type = "sprite", sprite = "space-location/" .. name}
	planet.style.size = 24
	planet.style.stretch_image_to_widget_size = true
	if disabled then
		local deny = icon.add{type = "sprite", sprite = "virtual-signal/signal-deny"}
		deny.style.size = 20
		deny.style.left_margin = -22
		deny.style.top_margin = 2
		deny.style.stretch_image_to_widget_size = true
	end
	local label = row.add{type = "label", caption = proto and proto.localised_name or name}
	label.style.single_line = false
	label.style.maximal_width = 170
	row.tooltip = {"", proto and proto.localised_name or name, disabled and " — unavailable on this instance" or " — default planet"}
end

function Panel.refresh_planets(player)
	local old = player.gui.left[PLANETS]
	if old then old.destroy() end
	old = player.gui.screen[PLANETS]
	if old then old.destroy() end
	local old_title = player.gui.screen[TITLE]
	if old_title then old_title.destroy() end
	storage.surface_export_panel_positions = nil
	local policy = storage.surface_export_planet_policy
	if not policy then return end
	local title = player.gui.screen.add{type = "frame", name = TITLE, direction = "horizontal"}
	title.style.padding = 8
	local label = title.add{type = "label", caption = {"", "Instance: ", policy.instance_name}, style = "frame_title"}
	label.style.horizontally_stretchable = true
	label.style.horizontal_align = "center"
	label.style.single_line = false
	Panel.refresh_position(player)
	local frame = player.gui.screen.add{type = "frame", name = PLANETS, direction = "vertical"}
	frame.style.width = WIDTH
	frame.style.padding = 8
	section_heading(frame, "Default Planet", DEFAULT_INFO)
	planet_row(inset(frame), policy.default_planet, false)
	local names = {}
	for name in pairs(policy.disabled) do names[#names + 1] = name end
	table.sort(names)
	section_heading(frame, "Unavailable Planets", UNAVAILABLE_INFO)
	local content = inset(frame).add{type = "scroll-pane", direction = "vertical", horizontal_scroll_policy = "never"}
	content.style.maximal_height = 224
	content.style.horizontally_stretchable = true
	for _, name in ipairs(names) do planet_row(content, name, true) end
	if #names == 0 then
		local none = content.add{type = "flow", direction = "horizontal"}
		none.style.height = 32
		none.style.vertical_align = "center"
		none.add{type = "label", caption = "None"}
	end
	frame.tags = {panel_height = 148 + math.min(224, 32 * math.max(1, #names))}
	Panel.refresh_position(player)
	Panel.refresh_visibility(player)
end

function Panel.refresh_button(player)
	Panel.close(player)
	Panel.refresh_planets(player)
	local policy = storage.surface_export_planet_policy
	local button = player.gui.top[OPEN]
	if button then button.destroy() end
	local toggle = player.gui.top[TOGGLE]
	if policy and not toggle then
		player.gui.top.add{type = "sprite-button", name = TOGGLE, sprite = "virtual-signal/signal-info", style = "mod_gui_button", auto_toggle = false,
			tooltip = "Instance planets: show or hide this instance's name, default planet and unavailable planets."}
	elseif not policy and toggle then toggle.destroy() end
	Panel.refresh_visibility(player)
	if not policy then Panel.close(player) end
end

function Panel.close(player)
	local frame = player.gui.screen[FRAME]
	if frame then frame.destroy() end
	if storage.surface_export_boarding_selections then storage.surface_export_boarding_selections[player.index] = nil end
end

function Panel.open(player)
	Panel.close(player)
	local policy = storage.surface_export_planet_policy
	if not policy then return end
	local frame = player.gui.screen.add{type = "frame", name = FRAME, direction = "vertical"}
	frame.style.width = WIDTH
	frame.style.padding = 8
	section_heading(frame, "Boarding", BOARDING_INFO)
	local content = inset(frame)
	local targets = Boarding.targets(player)
	local list_height = ROW * math.min(VISIBLE_ROWS, math.max(1, #targets)) + 8
	frame.tags = {panel_height = 64 + math.max(64, list_height), boarding_enabled = Boarding.enabled()}
	storage.surface_export_boarding_selections = storage.surface_export_boarding_selections or {}
	storage.surface_export_boarding_selections[player.index] = targets
	if not Boarding.enabled() then
		local label = content.add{type = "label", caption = "Boarding is disabled in map settings, or the companion mod needs updating."}
		label.style.single_line = false
		label.style.maximal_width = 228
	elseif #targets == 0 then
		local none = content.add{type = "flow", direction = "horizontal"}
		none.style.height = ROW
		none.style.vertical_align = "center"
		none.add{type = "label", caption = "None"}
	else
		local list = content.add{type = "scroll-pane", direction = "vertical", horizontal_scroll_policy = "never", vertical_scroll_policy = "auto"}
		list.style.minimal_height = list_height
		list.style.maximal_height = ROW * VISIBLE_ROWS + 8
		list.style.horizontally_stretchable = true
		for index, target in ipairs(targets) do
			local row = list.add{type = "flow", direction = "horizontal"}
			row.style.height = ROW
			row.style.width = 200
			row.style.vertical_align = "center"
			local label = row.add{type = "label", caption = target.name}
			label.style.single_line = false
			label.style.maximal_width = 128
			row.add{type = "empty-widget"}.style.horizontally_stretchable = true
			local button = row.add{type = "button", name = BOARD, caption = "Board", tags = {choice = index}}
			button.style.minimal_width = 64
		end
	end
	Panel.refresh_position(player)
end

function Panel.refresh(player)
	if not storage.surface_export_planet_policy then return end
	if not player.gui.screen[PLANETS] then Panel.refresh_button(player) end
	Panel.refresh_visibility(player)
	if player.controller_type ~= defines.controllers.remote then return end
	Panel.refresh_position(player)
	local frame = player.gui.screen[FRAME]
	if not frame or not frame.visible then return end
	local targets = Boarding.targets(player)
	local previous = (storage.surface_export_boarding_selections or {})[player.index] or {}
	local changed = #targets ~= #previous or frame.tags.boarding_enabled ~= Boarding.enabled()
	for i, target in ipairs(targets) do
		local old = previous[i]
		if not old or old.uid ~= target.uid or old.source_uid ~= target.source_uid or old.name ~= target.name then changed = true; break end
	end
	if changed then Panel.open(player) end
end

function Panel.on_gui_click(event)
	local element = event.element
	if not (element and element.valid) then return end
	if element.name == TOGGLE then
		local player = game.get_player(event.player_index)
		if not player then return end
		storage.surface_export_planet_panel_visible = storage.surface_export_planet_panel_visible or {}
		storage.surface_export_planet_panel_visible[player.index] = not storage.surface_export_planet_panel_visible[player.index]
		Panel.refresh_visibility(player)
		Panel.refresh_position(player)
		return
	end
	if element.name ~= OPEN and element.name ~= CLOSE and element.name ~= BOARD then return end
	local player = game.get_player(event.player_index)
	if not player then return end
	if element.name == OPEN then Panel.open(player)
	elseif element.name == CLOSE then Panel.close(player)
	else
		local frame = player.gui.screen[FRAME]
		local selections = storage.surface_export_boarding_selections or {}
		local index = element.tags and element.tags.choice
		local choice = frame and index and (selections[player.index] or {})[index]
		if not choice then player.print("Refresh the instance panel before boarding."); Panel.open(player); return end
		local ok, reason = Boarding.board(player, choice)
		if ok then Panel.close(player) else player.print(reason); Panel.open(player) end
	end
end

function Panel.on_gui_closed(event)
	if event.element and event.element.valid and event.element.name == FRAME then
		local player = game.get_player(event.player_index)
		if player then Panel.close(player) end
	end
end

return Panel
