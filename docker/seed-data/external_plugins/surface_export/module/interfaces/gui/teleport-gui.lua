-- FactorioSurfaceExport - Teleport GUI (/teleport)
--
-- Admin GUI: pick another cluster instance from a dropdown and press Connect. Connect fires
-- LuaPlayer.connect_to_server, which shows the player Factorio's NATIVE "connect to this
-- server?" prompt — consent is built in, and the call no-ops for non-multiplayer-peer contexts
-- (engine behavior; see docs/GATEWAY_TRANSFER_PRD.md).
--
-- The roster (instance name + client-routable address + online flag) comes from the CONTROLLER:
-- /teleport fires a send_json request; the instance plugin asks the controller (which joins each
-- instance's assigned host's public_address with its game port) and pushes the result back into
-- storage.teleport_roster via the remote interface. The GUI renders whatever roster is stored and
-- refreshes live when a fresh one lands. Address caveat, deployment not code: host.public_address
-- defaults to localhost — a distributed cluster must set it to something client-routable.

local clusterio_api = require("modules/clusterio/api")

local TeleportGui = {}

-- WHO MAY TELEPORT: admins, plus members of this Factorio-native permission group — save-persisted
-- and managed through the stock /permissions GUI (create nothing by hand; ensure_permission_group
-- below pre-creates it at startup). Measured 2026-07-31 on 2.1.11: a fresh permission group allows
-- every input action by default, so membership is behaviorally neutral — the group is purely a
-- teleport pass. Factorio's one-group-per-player rule is the known trade: a player in "Teleport"
-- is not in any other custom group.
TeleportGui.PERMISSION_GROUP = "Teleport"

--- May this player use /teleport (and press Connect)?
function TeleportGui.is_allowed(player)
	if player.admin then return true end
	local group = player.permission_group
	return group ~= nil and group.name == TeleportGui.PERMISSION_GROUP
end

--- Pre-create the pass group so admins find it ready in /permissions (idempotent, every startup).
function TeleportGui.ensure_permission_group()
	if not game.permissions.get_group(TeleportGui.PERMISSION_GROUP) then
		game.permissions.create_group(TeleportGui.PERMISSION_GROUP)
		log(string.format("[Teleport] created permission group '%s' (manage members via /permissions)",
			TeleportGui.PERMISSION_GROUP))
	end
end

-- Module-local state for open GUIs (runtime only, rebuilt on demand)
-- player_index → { frame = LuaGuiElement, dropdown = LuaGuiElement, entries = array }
local open_guis = {}

local FRAME_NAME = "surface_export_teleport"
local DROPDOWN_NAME = "surface_export_teleport_dropdown"
local CONNECT_NAME = "surface_export_teleport_connect"
local CLOSE_NAME = "surface_export_teleport_close"
local REFRESH_NAME = "surface_export_teleport_refresh"

--- Selectable = other instances, online first, each labeled honestly.
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

--- Build (or rebuild) the GUI content for one player. A rebuild preserves the player's dropdown
--- selection by instanceId — the roster refresh fired at /teleport-open lands moments later, and
--- silently resetting a made selection to row 1 would connect somewhere the admin did not pick.
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

--- Open the GUI for a player (the /teleport command entry point).
function TeleportGui.open(player)
	build(player)
end

--- A fresh roster arrived (remote teleport_roster_update) — rebuild every open GUI in place.
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
		-- Our frame exists but module-local state was lost (it does not survive save/load, the
		-- frame does) — destroy the orphan so the buttons are never dead. Same shape as the
		-- gateway-transfer GUI, which fixed this exact class before this file existed.
		local player = game.get_player(event.player_index)
		local orphan = player and player.gui.screen[FRAME_NAME]
		if orphan then orphan.destroy() end
		return
	end

	if element.name == CLOSE_NAME then
		close(event.player_index)
	elseif element.name == REFRESH_NAME then
		-- The command module re-fires the roster request; the GUI rebuilds when it lands.
		local player = game.get_player(event.player_index)
		if player then
			TeleportGui.request_roster()
			player.print("Refreshing the instance roster…")
		end
	elseif element.name == CONNECT_NAME then
		local player = game.get_player(event.player_index)
		if not player then return end
		-- Re-check at the moment of truth: a player pulled from the group (or de-admined) with the
		-- GUI already open must not connect off a stale pass.
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
		-- Orphaned frame (state lost on save/load): Esc must actually close it.
		element.destroy()
		open_guis[event.player_index] = nil
	end
end

--- Ask the instance plugin for a fresh roster (it asks the controller and pushes the result back
--- via the teleport_roster_update remote). Fire-and-forget; the GUI rebuilds when data lands.
function TeleportGui.request_roster()
	clusterio_api.send_json("surface_teleport_roster_request", {})
end

return TeleportGui
