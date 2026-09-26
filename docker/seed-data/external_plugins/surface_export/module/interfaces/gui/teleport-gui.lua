local clusterio_api = require("modules/clusterio/api")

local TeleportGui = {}

TeleportGui.PERMISSION_GROUP = "Teleport"

function TeleportGui.is_allowed(player)
	if player.admin then return true end
	local group = player.permission_group
	return group ~= nil and group.name == TeleportGui.PERMISSION_GROUP
end

function TeleportGui.ensure_permission_group()
	if not game.permissions.get_group(TeleportGui.PERMISSION_GROUP) then
		game.permissions.create_group(TeleportGui.PERMISSION_GROUP)
		log(string.format("[Teleport] created permission group '%s' (manage members via /permissions)",
			TeleportGui.PERMISSION_GROUP))
	end
end

local FRAME_NAME = "surface_export_teleport"
local PREFIX = "surface_export_teleport_"
local CONNECT_NAME = PREFIX .. "connect"
local CLOSE_NAME = PREFIX .. "close"
local CANCEL_NAME = PREFIX .. "cancel"
local REFRESH_NAME = PREFIX .. "refresh"
local ICON = "space-location/surfexp_gateway_3"
local WIDTH = 380

local COLOR_MUTED = {r = 0.7, g = 0.7, b = 0.7}
local COLOR_ONLINE = {r = 0.4, g = 1.0, b = 0.4}
local COLOR_OFFLINE = {r = 1.0, g = 0.45, b = 0.4}

TeleportGui.ICON = ICON

local function open_guis()
	storage.surface_export_teleport_guis = storage.surface_export_teleport_guis or {}
	return storage.surface_export_teleport_guis
end

local function roster_entries()
	local roster = storage.teleport_roster
	local entries = {}
	for _, inst in ipairs((roster and roster.instances) or {}) do
		if not inst.self then
			entries[#entries + 1] = inst
		end
	end
	table.sort(entries, function(a, b)
		if a.online ~= b.online then return a.online end
		return tostring(a.name) < tostring(b.name)
	end)
	return entries
end

local function selected_entry(state)
	for _, entry in ipairs(state.entries or {}) do
		if entry.instanceId == state.selected_id and entry.online then return entry end
	end
end

local function titlebar(frame)
	local bar = frame.add{type = "flow", direction = "horizontal"}
	bar.drag_target = frame
	bar.style.horizontal_spacing = 8
	bar.add{type = "label", caption = "Teleport", style = "frame_title", ignored_by_interaction = true}
	local drag = bar.add{type = "empty-widget", style = "draggable_space_header", ignored_by_interaction = true}
	drag.style.horizontally_stretchable = true
	drag.style.height = 24
	drag.style.right_margin = 4
	bar.add{type = "sprite-button", name = REFRESH_NAME, style = "frame_action_button", sprite = "utility/refresh", tooltip = "Refresh the instance list"}
	bar.add{type = "sprite-button", name = CLOSE_NAME, style = "frame_action_button", sprite = "utility/close", tooltip = "Close"}
end

local function build(player)
	local state = open_guis()[player.index] or {}
	local existing = player.gui.screen[FRAME_NAME]
	if existing then existing.destroy() end

	state.entries = roster_entries()
	if not selected_entry(state) then
		state.selected_id = nil
		for _, entry in ipairs(state.entries) do
			if entry.online then state.selected_id = entry.instanceId break end
		end
	end

	local frame = player.gui.screen.add{type = "frame", name = FRAME_NAME, direction = "vertical"}
	frame.auto_center = true
	titlebar(frame)
	local body = frame.add{type = "frame", style = "inside_shallow_frame_with_padding", direction = "vertical"}
	body.style.minimal_width = WIDTH
	local content = body.add{type = "flow", direction = "vertical"}
	content.style.vertical_spacing = 8

	local header = content.add{type = "flow", direction = "horizontal"}
	header.style.vertical_align = "center"
	header.style.horizontal_spacing = 8
	local icon = header.add{type = "sprite", sprite = helpers.is_valid_sprite_path(ICON) and ICON or "utility/character_running_speed_modifier_icon"}
	icon.style.size = 32
	icon.style.stretch_image_to_widget_size = true
	local names = header.add{type = "flow", direction = "vertical"}
	names.style.vertical_spacing = 0
	names.add{type = "label", caption = "Connect to another instance", style = "bold_label"}
	local hint = names.add{type = "label", caption = "You travel alone. Your platform stays here."}
	hint.style.font_color = COLOR_MUTED

	content.add{type = "label", caption = "Destination", style = "bold_label"}
	local list = content.add{type = "frame", style = "deep_frame_in_shallow_frame", direction = "vertical"}
	list.style.horizontally_stretchable = true
	if #state.entries == 0 then
		local empty = list.add{type = "label", caption = storage.teleport_roster and "No other instances in the cluster."
			or "Fetching the instance list from the controller…"}
		empty.style.font_color = COLOR_MUTED
		empty.style.margin = 8
	end
	for idx, entry in ipairs(state.entries) do
		local online = entry.online == true
		local row = list.add{type = "flow", direction = "horizontal"}
		row.style.vertical_align = "center"
		row.style.horizontal_spacing = 8
		row.style.left_margin = 8
		row.style.right_margin = 8
		row.style.top_margin = 4
		row.style.bottom_margin = 4
		local radio = row.add{type = "radiobutton", name = PREFIX .. "target_" .. idx, state = state.selected_id == entry.instanceId,
			caption = entry.name, tags = {teleport_instance = entry.instanceId}}
		radio.enabled = online
		if entry.address and entry.address ~= "" then
			local address = row.add{type = "label", caption = entry.address}
			address.style.font_color = COLOR_MUTED
		end
		row.add{type = "empty-widget"}.style.horizontally_stretchable = true
		local status = row.add{type = "sprite", sprite = online and "utility/status_working" or "utility/status_not_working"}
		status.style.size = 16
		status.style.stretch_image_to_widget_size = true
		local status_label = row.add{type = "label", caption = online and "Online" or "Offline"}
		status_label.style.font_color = online and COLOR_ONLINE or COLOR_OFFLINE
	end

	local footer = frame.add{type = "flow", direction = "horizontal", style = "dialog_buttons_horizontal_flow"}
	footer.add{type = "button", name = CANCEL_NAME, caption = "Close", style = "back_button"}
	local pusher = footer.add{type = "empty-widget", style = "draggable_space", ignored_by_interaction = true}
	pusher.style.horizontally_stretchable = true
	pusher.style.height = 32
	local connect = footer.add{type = "button", name = CONNECT_NAME, caption = "Connect", style = "confirm_button"}
	connect.enabled = selected_entry(state) ~= nil
	if not connect.enabled then connect.tooltip = "Choose an online instance." end

	player.opened = frame
	open_guis()[player.index] = state
end

function TeleportGui.open(player)
	build(player)
end

function TeleportGui.is_open(player)
	return player.gui.screen[FRAME_NAME] ~= nil
end

function TeleportGui.refresh_all()
	for player_index in pairs(open_guis()) do
		local player = game.get_player(player_index)
		if player and player.valid and player.gui.screen[FRAME_NAME] then
			build(player)
		else
			open_guis()[player_index] = nil
		end
	end
end

local function close(player_index)
	local player = game.get_player(player_index)
	local frame = player and player.gui.screen[FRAME_NAME]
	if frame then frame.destroy() end
	open_guis()[player_index] = nil
end

function TeleportGui.close(player)
	close(player.index)
end

function TeleportGui.on_gui_click(event)
	local element = event.element
	if not (element and element.valid and type(element.name) == "string") then return end
	local name = element.name
	if name:sub(1, #PREFIX) ~= PREFIX then return end
	local player = game.get_player(event.player_index)
	if not player then return end

	local state = open_guis()[event.player_index]
	if not state or name == CLOSE_NAME or name == CANCEL_NAME then
		close(event.player_index)
		return
	end

	local instance_id = element.tags and element.tags.teleport_instance
	if instance_id then
		state.selected_id = instance_id
		build(player)
	elseif name == REFRESH_NAME then
		TeleportGui.request_roster()
	elseif name == CONNECT_NAME then
		if not TeleportGui.is_allowed(player) then
			player.print(string.format(
				"You are no longer allowed to teleport (admins or the '%s' permission group).",
				TeleportGui.PERMISSION_GROUP))
			close(event.player_index)
			return
		end
		local entry = selected_entry(state)
		if not entry then
			player.print("Choose an online instance first.")
			return
		end
		if not entry.address or entry.address == "" then
			player.print(string.format("%s has no routable address (is it running?).", entry.name))
			return
		end
		player.connect_to_server{ address = entry.address, name = entry.name }
		player.print(string.format(
			"Connect prompt sent for %s (%s) — accept the dialog to switch servers.",
			entry.name, entry.address))
		close(event.player_index)
	end
end

function TeleportGui.on_gui_closed(event)
	local element = event.element
	if element and element.valid and element.name == FRAME_NAME then
		close(event.player_index)
	end
end

function TeleportGui.request_roster()
	clusterio_api.send_json("surface_teleport_roster_request", {})
end

function TeleportGui.announce_arrival(player_name, source_name, target_name)
	local player = game.get_player(player_name)
	if not (player and player.valid and player.connected) then return {success = false, error = "Player is no longer connected"} end
	if (storage.surface_export_pending_arrivals or {})[player.index] then
		storage.surface_export_pending_announcements = storage.surface_export_pending_announcements or {}
		storage.surface_export_pending_announcements[player_name] = {source = source_name, target = target_name}
		return {success = true}
	end
	local surface = game.get_surface(player.physical_surface_index)
	local location = surface and (surface.planet or (surface.platform and surface.platform.space_location))
	local function text(value) return (value:gsub("%[", "("):gsub("%]", ")")) end
	local message = {"", "[img=space-location/surfexp_gateway_hub] ", text(player.name), " moved from ", text(source_name), " to ", text(target_name)}
	if location then
		message[#message + 1] = " → [img=space-location/" .. location.name .. "] "
		message[#message + 1] = prototypes.space_location[location.name].localised_name
	end
	game.print(message, {color = player.color})
	return {success = true}
end

function TeleportGui.flush_announcements()
	local pending = storage.surface_export_pending_announcements
	if not pending then return end
	storage.surface_export_pending_announcements = {}
	for name, entry in pairs(pending) do
		TeleportGui.announce_arrival(name, entry.source, entry.target)
	end
end

return TeleportGui
