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

local open_guis = {}

local FRAME_NAME = "surface_export_teleport"
local DROPDOWN_NAME = "surface_export_teleport_dropdown"
local CONNECT_NAME = "surface_export_teleport_connect"
local CLOSE_NAME = "surface_export_teleport_close"
local REFRESH_NAME = "surface_export_teleport_refresh"

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

local function dropdown_items(entries)
	local items = {}
	for _, inst in ipairs(entries) do
		items[#items + 1] = string.format("%s  (%s)%s", inst.name, inst.address,
			inst.online and "" or "  [OFFLINE]")
	end
	return items
end

local function build(player)
	local prior = open_guis[player.index]
	local prior_id = nil
	if prior and prior.dropdown and prior.dropdown.valid and prior.entries then
		local prior_entry = prior.entries[prior.dropdown.selected_index]
		prior_id = prior_entry and prior_entry.instanceId
	end

	local existing = player.gui.screen[FRAME_NAME]
	if existing then existing.destroy() end

	local frame = player.gui.screen.add{
		type = "frame",
		name = FRAME_NAME,
		caption = "Teleport — connect to another instance",
		direction = "vertical"
	}
	frame.auto_center = true

	local entries = roster_entries()
	local content = frame.add{type = "flow", direction = "vertical"}

	local dropdown = nil
	if #entries == 0 then
		local roster = storage.teleport_roster
		content.add{
			type = "label",
			caption = roster and "No other instances in the roster." or
				"Fetching the instance roster from the controller…"
		}
	else
		local selected = 1
		if prior_id then
			for i, inst in ipairs(entries) do
				if inst.instanceId == prior_id then selected = i end
			end
		end
		content.add{type = "label", caption = "Destination instance:"}
		dropdown = content.add{
			type = "drop-down",
			name = DROPDOWN_NAME,
			items = dropdown_items(entries),
			selected_index = selected
		}
		dropdown.style.minimal_width = 320
	end

	local buttons = frame.add{type = "flow", direction = "horizontal"}
	buttons.add{type = "button", name = CONNECT_NAME, caption = "Connect", style = "confirm_button",
		enabled = #entries > 0}
	buttons.add{type = "button", name = REFRESH_NAME, caption = "Refresh"}
	buttons.add{type = "button", name = CLOSE_NAME, caption = "Close"}

	player.opened = frame
	open_guis[player.index] = { frame = frame, dropdown = dropdown, entries = entries }
end

function TeleportGui.open(player)
	build(player)
end

function TeleportGui.refresh_all()
	for player_index in pairs(open_guis) do
		local player = game.get_player(player_index)
		if player and player.valid then
			build(player)
		else
			open_guis[player_index] = nil
		end
	end
end

local function close(player_index)
	local state = open_guis[player_index]
	if state and state.frame and state.frame.valid then
		state.frame.destroy()
	end
	open_guis[player_index] = nil
end

function TeleportGui.on_gui_click(event)
	local element = event.element
	if not (element and element.valid) then return end
	local name = element.name
	if name ~= CLOSE_NAME and name ~= REFRESH_NAME and name ~= CONNECT_NAME then return end

	local state = open_guis[event.player_index]
	if not state then
		local player = game.get_player(event.player_index)
		local orphan = player and player.gui.screen[FRAME_NAME]
		if orphan then orphan.destroy() end
		return
	end

	if element.name == CLOSE_NAME then
		close(event.player_index)
	elseif element.name == REFRESH_NAME then
		local player = game.get_player(event.player_index)
		if player then
			TeleportGui.request_roster()
			player.print("Refreshing the instance roster…")
		end
	elseif element.name == CONNECT_NAME then
		local player = game.get_player(event.player_index)
		if not player then return end
		if not TeleportGui.is_allowed(player) then
			player.print(string.format(
				"You are no longer allowed to teleport (admins or the '%s' permission group).",
				TeleportGui.PERMISSION_GROUP))
			close(event.player_index)
			return
		end
		local dropdown = state.dropdown
		local entry = dropdown and dropdown.valid and state.entries[dropdown.selected_index]
		if not entry then
			player.print("Select a destination instance first.")
			return
		end
		if not entry.online then
			player.print(string.format("%s is OFFLINE — not sending a connect prompt.", entry.name))
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
	if not (element and element.valid and element.name == FRAME_NAME) then return end
	local state = open_guis[event.player_index]
	if state and state.frame and state.frame.valid and element.index == state.frame.index then
		close(event.player_index)
	else
		element.destroy()
		open_guis[event.player_index] = nil
	end
end

function TeleportGui.request_roster()
	clusterio_api.send_json("surface_teleport_roster_request", {})
end

return TeleportGui
