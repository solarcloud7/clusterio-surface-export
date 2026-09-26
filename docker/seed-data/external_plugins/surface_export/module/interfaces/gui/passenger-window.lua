local PassengerWindow = {}

local FRAME = "surfexp_passenger_frame"
local PREFIX = "surfexp_px_"
local WIDTH = 380

local COLOR_MUTED = {r = 0.7, g = 0.7, b = 0.7}

PassengerWindow.FRAME = FRAME
PassengerWindow.PREFIX = PREFIX
PassengerWindow.ABORT = PREFIX .. "abort"
PassengerWindow.JOIN = PREFIX .. "join"
PassengerWindow.STAY = PREFIX .. "stay"
PassengerWindow.CLOSE = PREFIX .. "close"

local function planet_sprite(planet)
	local path = "space-location/" .. tostring(planet)
	return helpers.is_valid_sprite_path(path) and path or "entity/character"
end

local function planet_label(planet)
	local proto = prototypes.space_location[planet]
	return proto and proto.localised_name or planet
end

local function titlebar(frame)
	local bar = frame.add{type = "flow", direction = "horizontal"}
	bar.drag_target = frame
	bar.style.horizontal_spacing = 8
	bar.add{type = "label", caption = "Gateway transfer", style = "frame_title", ignored_by_interaction = true}
	local drag = bar.add{type = "empty-widget", style = "draggable_space_header", ignored_by_interaction = true}
	drag.style.horizontally_stretchable = true
	drag.style.height = 24
	drag.style.right_margin = 4
	bar.add{type = "sprite-button", name = PREFIX .. "close", style = "frame_action_button", sprite = "utility/close", tooltip = "Hide this window"}
end

local function header(content, title, subtitle, gateway)
	local row = content.add{type = "flow", direction = "horizontal"}
	row.style.vertical_align = "center"
	row.style.horizontal_spacing = 8
	local icon_path = "space-location/" .. tostring(gateway or "surfexp_gateway_hub")
	local icon = row.add{type = "sprite", sprite = helpers.is_valid_sprite_path(icon_path) and icon_path or "entity/space-platform-hub"}
	icon.style.size = 32
	icon.style.stretch_image_to_widget_size = true
	local names = row.add{type = "flow", direction = "vertical"}
	names.style.vertical_spacing = 0
	names.add{type = "label", name = PREFIX .. "title", caption = title, style = "bold_label"}
	local hint = names.add{type = "label", caption = subtitle}
	hint.style.single_line = false
	hint.style.maximal_width = WIDTH - 60
	hint.style.font_color = COLOR_MUTED
end

local function frame_for(player)
	local existing = player.gui.screen[FRAME]
	if existing then existing.destroy() end
	local frame = player.gui.screen.add{type = "frame", direction = "vertical", name = FRAME}
	frame.auto_center = true
	titlebar(frame)
	local body = frame.add{type = "frame", style = "inside_shallow_frame_with_padding", direction = "vertical"}
	body.style.minimal_width = WIDTH
	local content = body.add{type = "flow", direction = "vertical"}
	content.style.vertical_spacing = 8
	return frame, content
end

local function footer(frame)
	local flow = frame.add{type = "flow", direction = "horizontal", style = "dialog_buttons_horizontal_flow"}
	flow.style.vertical_align = "center"
	return flow
end

local function pusher(flow)
	local widget = flow.add{type = "empty-widget", style = "draggable_space", ignored_by_interaction = true}
	widget.style.horizontally_stretchable = true
	widget.style.height = 32
end

local function planet_button(flow, name, planet, tooltip)
	local button = flow.add{type = "sprite-button", name = name, sprite = planet_sprite(planet), tooltip = tooltip}
	button.style.size = 40
	return button
end

function PassengerWindow.show_transit(player, record, planet)
	local frame, content = frame_for(player)
	header(content, {"", "Transferring to → ", record.destination_name or "another instance"},
		"Your character is held until the platform arrives.", record.gateway_name)
	local flow = footer(frame)
	planet_button(flow, PassengerWindow.ABORT, planet, {"", "Abort: stay on ", planet_label(planet)})
	flow.add{type = "label", caption = {"", "Abort and stay on ", planet_label(planet)}}
	pusher(flow)
	player.opened = frame
	return frame
end

function PassengerWindow.show_arrived(player, record, planet)
	local frame, content = frame_for(player)
	header(content, {"", "Arrived at ", record.destination_name or "another instance"},
		"Join to continue aboard your platform there.", record.gateway_name)
	local flow = footer(frame)
	planet_button(flow, PassengerWindow.STAY, planet, {"", "Stay on ", planet_label(planet)})
	flow.add{type = "label", caption = {"", "Stay on ", planet_label(planet)}}
	pusher(flow)
	local join = flow.add{type = "button", name = PassengerWindow.JOIN,
		caption = {"", "Join ", record.destination_name or "destination"}, style = "confirm_button"}
	join.enabled = type(record.destination_address) == "string" and record.destination_address ~= ""
	if not join.enabled then join.tooltip = "The destination has no routable address." end
	player.opened = frame
	return frame
end

function PassengerWindow.is_open(player)
	return player.gui.screen[FRAME] ~= nil
end

function PassengerWindow.close(player)
	if player and player.valid and player.gui.screen[FRAME] then
		player.gui.screen[FRAME].destroy()
	end
end

return PassengerWindow
