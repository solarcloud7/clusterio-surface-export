local platform_identity = require("modules/surface_export/utils/platform-identity")
local Gateway = require("modules/surface_export/core/gateway")
local GatewayGuard = require("modules/surface_export/core/gateway-guard")
local TransferTrigger = require("modules/surface_export/core/transfer-trigger")
local SurfaceLock = require("modules/surface_export/utils/surface-lock")
local PassengerTransit = require("modules/surface_export/core/passenger-transit")

local GatewayTransferGui = {}

local FRAME = "surfexp_gateway_frame"
local PREFIX = "surfexp_gw_"
local CLOSE_DELAY_TICKS = 120
local WIDTH = 380

local COLOR_WARN = {r = 1.0, g = 0.5, b = 0.4}
local COLOR_MUTED = {r = 0.7, g = 0.7, b = 0.7}
local COLOR_ONLINE = {r = 0.4, g = 1.0, b = 0.4}
local COLOR_OFFLINE = {r = 1.0, g = 0.45, b = 0.4}

local function dialogs()
	storage.surface_export_gateway_dialogs = storage.surface_export_gateway_dialogs or {}
	return storage.surface_export_gateway_dialogs
end

local function resolve_platform(state)
	local force = state and game.forces[state.force_name]
	if not force then return nil end
	local platform = force.platforms[state.platform_index]
	if not (platform and platform.valid) or not state.platform_uid
		or platform_identity(platform) ~= state.platform_uid then return nil end
	return platform
end

local function location_name(name)
	local proto = prototypes.space_location[name]
	return proto and proto.localised_name or name
end

local function default_selection(targets)
	local online
	for idx, target in ipairs(targets) do
		if target.online then
			if online then return nil end
			online = idx
		end
	end
	return online
end

local function sync_targets(state)
	local cfg = Gateway.get_gateway_config(state.gateway_name)
	local targets = (cfg and cfg.targets) or state.targets or {}
	local previous = state.selected and state.targets and state.targets[state.selected]
	state.targets = targets
	state.selected = nil
	if previous then
		for idx, target in ipairs(targets) do
			if target.instanceId == previous.instanceId and target.online then state.selected = idx end
		end
	end
	if not state.selected and not state.chosen then state.selected = default_selection(targets) end
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
	bar.add{type = "sprite-button", name = PREFIX .. "close", style = "frame_action_button", sprite = "utility/close", tooltip = "Stay at the gateway"}
end

local function note(parent, caption, color)
	local label = parent.add{type = "label", caption = caption}
	label.style.single_line = false
	label.style.maximal_width = WIDTH - 24
	label.style.font_color = color
	return label
end

local function build_frame(player, state)
	local existing = player.gui.screen[FRAME]
	if existing then existing.destroy() end
	sync_targets(state)

	local frame = player.gui.screen.add{type = "frame", direction = "vertical", name = FRAME}
	frame.auto_center = true
	titlebar(frame)
	local body = frame.add{type = "frame", style = "inside_shallow_frame_with_padding", direction = "vertical"}
	body.style.minimal_width = WIDTH
	local content = body.add{type = "flow", direction = "vertical"}
	content.style.vertical_spacing = 8

	local platform = resolve_platform(state)
	local decision = {allowed = false, passenger_count = 0}
	local in_flight = false
	if not platform then
		note(content, "This platform is no longer available.", COLOR_WARN)
	else
		local aboard_players, char_count = Gateway.collect_passengers(platform)
		in_flight = SurfaceLock.is_locked(platform.index)
		decision = GatewayGuard.evaluate{
			docked = (Gateway.parked_at_gateway(platform) == state.gateway_name),
			in_flight = in_flight,
			aboard_players = aboard_players,
			aboard_characters = char_count,
		}

		local header = content.add{type = "flow", direction = "horizontal"}
		header.style.vertical_align = "center"
		header.style.horizontal_spacing = 8
		local icon_path = "space-location/" .. state.gateway_name
		local icon = header.add{type = "sprite", sprite = helpers.is_valid_sprite_path(icon_path) and icon_path or "entity/space-platform-hub"}
		icon.style.size = 32
		icon.style.stretch_image_to_widget_size = true
		local names = header.add{type = "flow", direction = "vertical"}
		names.style.vertical_spacing = 0
		names.add{type = "label", caption = platform.name, style = "bold_label"}
		local where = names.add{type = "label", caption = {"", state.departed and "Left " or "Parked at ", location_name(state.gateway_name)}}
		where.style.font_color = COLOR_MUTED
		if decision.passenger_count > 0 then
			header.add{type = "empty-widget"}.style.horizontally_stretchable = true
			local tip = decision.passenger_count == 1 and "1 player aboard" or (decision.passenger_count .. " players aboard")
			local who = header.add{type = "sprite", name = PREFIX .. "aboard_icon", sprite = "entity/character", tooltip = tip}
			who.style.size = 24
			who.style.stretch_image_to_widget_size = true
			header.add{type = "label", name = PREFIX .. "aboard_count", caption = "× " .. decision.passenger_count, style = "bold_label", tooltip = tip}
		end

		if state.departed then
			note(content, "The platform left the gateway. This window will close.", COLOR_MUTED)
		elseif in_flight then
			note(content, "This platform is already transferring.", COLOR_WARN)
		end

		content.add{type = "label", caption = "Destination", style = "bold_label"}
		local list = content.add{type = "frame", style = "deep_frame_in_shallow_frame", direction = "vertical"}
		list.style.horizontally_stretchable = true
		for idx, target in ipairs(state.targets) do
			local online = target.online == true
			local row = list.add{type = "flow", direction = "horizontal"}
			row.style.vertical_align = "center"
			row.style.horizontal_spacing = 8
			row.style.left_margin = 8
			row.style.right_margin = 8
			row.style.top_margin = 4
			row.style.bottom_margin = 4
			local radio = row.add{type = "radiobutton", name = PREFIX .. "target_" .. idx, state = state.selected == idx,
				caption = target.instanceName or ("instance " .. tostring(target.instanceId)), tags = {gw_target_idx = idx}}
			radio.enabled = online and not state.departed
			if target.targetGateway and target.targetGateway ~= state.gateway_name then
				local arrival = row.add{type = "label", caption = {"", "→ ", location_name(target.targetGateway)}}
				arrival.style.font_color = COLOR_MUTED
			end
			row.add{type = "empty-widget"}.style.horizontally_stretchable = true
			local status = row.add{type = "sprite", sprite = online and "utility/status_working" or "utility/status_not_working"}
			status.style.size = 16
			status.style.stretch_image_to_widget_size = true
			local status_label = row.add{type = "label", caption = online and "Online" or "Offline"}
			status_label.style.font_color = online and COLOR_ONLINE or COLOR_OFFLINE
		end
	end

	local footer = frame.add{type = "flow", direction = "horizontal", style = "dialog_buttons_horizontal_flow"}
	footer.add{type = "button", name = PREFIX .. "cancel", caption = "Stay", style = "back_button"}
	local pusher = footer.add{type = "empty-widget", style = "draggable_space", ignored_by_interaction = true}
	pusher.style.horizontally_stretchable = true
	pusher.style.height = 32
	local transfer = footer.add{type = "button", name = PREFIX .. "transfer", caption = "Transfer", style = "confirm_button"}
	transfer.enabled = platform ~= nil and state.selected ~= nil and decision.allowed == true
	if not transfer.enabled then
		transfer.tooltip = state.departed and "The platform left the gateway."
			or in_flight and "This platform is already transferring."
			or state.selected == nil and "Choose an online destination."
			or "The platform must be parked at the gateway."
	end
	player.opened = frame
	dialogs()[player.index] = state
end

function GatewayTransferGui.open(player, platform, gateway_name)
	if not (player and player.valid and platform and platform.valid) then
		return false
	end
	local cfg = Gateway.get_gateway_config(gateway_name)
	local targets = (cfg and cfg.targets) or {}
	if #targets == 0 then
		player.print({"", "Gateway '", gateway_name, "' has no configured destinations. Set links in the web UI → Gateways tab."})
		return false
	end
	local state = {
		platform_index = platform.index,
		platform_uid = platform_identity(platform),
		force_name = platform.force.name,
		gateway_name = gateway_name,
		targets = targets,
	}
	dialogs()[player.index] = state
	build_frame(player, state)
	return true
end

function GatewayTransferGui.offer(player)
	if not (player and player.valid and player.connected) then return false end
	local surface = game.get_surface(player.physical_surface_index)
	local platform = surface and surface.platform
	local gateway_name = platform and Gateway.parked_at_gateway(platform)
	if not gateway_name or SurfaceLock.is_locked(platform.index) then return false end
	local cfg = Gateway.get_gateway_config(gateway_name)
	if not (cfg and cfg.targets and #cfg.targets > 0) then return false end
	local state = dialogs()[player.index]
	if state and state.platform_index == platform.index and player.gui.screen[FRAME] then return true end
	return GatewayTransferGui.open(player, platform, gateway_name)
end

function GatewayTransferGui.is_open(player)
	return player.gui.screen[FRAME] ~= nil
end

function GatewayTransferGui.close(player)
	if player and player.valid and player.gui.screen[FRAME] then
		player.gui.screen[FRAME].destroy()
	end
	if player then
		dialogs()[player.index] = nil
	end
end

function GatewayTransferGui.refresh_open()
	for player_index, state in pairs(dialogs()) do
		local player = game.get_player(player_index)
		if player and player.valid and player.connected and player.gui.screen[FRAME] then
			build_frame(player, state)
		end
	end
end

function GatewayTransferGui.platform_state_changed(platform)
	if not (platform and platform.valid) then return end
	local parked = Gateway.parked_at_gateway(platform)
	for player_index, state in pairs(dialogs()) do
		if state.platform_index == platform.index and state.force_name == platform.force.name then
			if parked == state.gateway_name then
				state.departed, state.close_tick = nil, nil
			elseif not state.close_tick then
				state.departed, state.close_tick = true, game.tick + CLOSE_DELAY_TICKS
			end
			local player = game.get_player(player_index)
			if player and player.valid and player.gui.screen[FRAME] then build_frame(player, state) end
		end
	end
end

function GatewayTransferGui.on_tick()
	local open = storage.surface_export_gateway_dialogs
	if not open or next(open) == nil then return end
	for player_index, state in pairs(open) do
		if state.close_tick and game.tick >= state.close_tick then
			local player = game.get_player(player_index)
			if player then GatewayTransferGui.close(player) else open[player_index] = nil end
		end
	end
end

function GatewayTransferGui.on_gui_click(event)
	local element = event.element
	if not (element and element.valid and type(element.name) == "string") then return end
	if element.name:sub(1, #PREFIX) ~= PREFIX then return end

	local player = game.get_player(event.player_index)
	local state = dialogs()[event.player_index]

	if element.name == PREFIX .. "cancel" or element.name == PREFIX .. "close" or not state then
		GatewayTransferGui.close(player)
		return
	end

	local pick_idx = element.tags and element.tags.gw_target_idx
	if pick_idx then
		state.selected = pick_idx
		state.chosen = true
		build_frame(player, state)
		return
	end

	if element.name == PREFIX .. "transfer" then
		GatewayTransferGui.confirm_transfer(player, state)
	end
end

function GatewayTransferGui.confirm_transfer(player, state)
	local target = state.targets and state.targets[state.selected]
	if not target then
		player.print("Select a destination first.")
		return
	end
	local platform = resolve_platform(state)
	if not platform then
		player.print("This platform is no longer available.")
		GatewayTransferGui.close(player)
		return
	end

	local gw_now = Gateway.parked_at_gateway(platform)
	local aboard_players, char_count = Gateway.collect_passengers(platform)
	local force = game.forces[state.force_name]
	local guard = {
		docked = (gw_now == state.gateway_name),
		in_flight = SurfaceLock.is_locked(platform.index),
		aboard_players = aboard_players,
		aboard_characters = char_count,
	}

	local parked = {}
	if GatewayGuard.evaluate(guard).allowed then
		for _, passenger in ipairs(aboard_players) do
			if passenger.index ~= player.index then GatewayTransferGui.close(passenger) end
		end
		parked = PassengerTransit.park(platform, target, state.gateway_name, aboard_players)
	end
	local job_id
	guard.start_fn = function()
		local ok, id, err = pcall(TransferTrigger.start, force, state.platform_index, target.instanceId, target.targetGateway or state.gateway_name)
		if not ok then
			log("[Gateway] transfer start raised: " .. tostring(id))
			local lock = SurfaceLock.get_lock_data(platform.index)
			local exporting = false
			for _, job in pairs(storage.async_jobs or {}) do
				if job.platform_index == state.platform_index and job.force_name == state.force_name then exporting = true end
			end
			if lock and lock.kind == "transfer" and not exporting then
				local released, release_err = SurfaceLock.unlock_current_lock(platform.index, lock)
				if not released then log("[Gateway] releasing the lock after a failed start failed: " .. tostring(release_err)) end
			end
			return nil, tostring(id)
		end
		job_id = id
		return id, err
	end
	local result = GatewayGuard.guard_and_transfer(guard)

	if result.started then
		PassengerTransit.assign_job(parked, job_id)
		GatewayTransferGui.close(player)
		return
	end
	PassengerTransit.return_parked(parked)

	if result.reason == GatewayGuard.REASON.IN_FLIGHT then
		player.print("✗ Cannot transfer: this platform is already transferring.")
	elseif result.reason == GatewayGuard.REASON.NOT_DOCKED then
		player.print("✗ Cannot transfer: the platform is no longer parked at the gateway.")
	elseif result.start_err then
		player.print({"", "✗ Transfer failed to start: ", tostring(result.start_err)})
	else
		player.print("✗ Transfer could not start.")
	end
	if dialogs()[player.index] then
		build_frame(player, state)
	end
end

function GatewayTransferGui.on_gui_closed(event)
	local element = event.element
	if element and element.valid and element.name == FRAME then
		GatewayTransferGui.close(game.get_player(event.player_index))
	end
end

return GatewayTransferGui
