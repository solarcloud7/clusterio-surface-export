local Gateway = require("modules/surface_export/core/gateway")
local GatewayGuard = require("modules/surface_export/core/gateway-guard")
local TransferTrigger = require("modules/surface_export/core/transfer-trigger")
local SurfaceLock = require("modules/surface_export/utils/surface-lock")

local GatewayTransferGui = {}

local FRAME = "surfexp_gateway_frame"
local PREFIX = "surfexp_gw_"

local open_guis = {}

local COLOR_ONLINE = {r = 0.4, g = 1.0, b = 0.4}
local COLOR_OFFLINE = {r = 0.9, g = 0.6, b = 0.3}
local COLOR_WARN = {r = 1.0, g = 0.5, b = 0.4}




local function resolve_platform(state)
	local force = state and game.forces[state.force_name]
	if not force then return nil end
	local platform = force.platforms[state.platform_index]
	if not (platform and platform.valid) then return nil end
	return platform
end

local function build_frame(player, state)
	if player.gui.screen[FRAME] then
		player.gui.screen[FRAME].destroy()
	end

	local frame = player.gui.screen.add{
		type = "frame",
		direction = "vertical",
		name = FRAME,
		caption = {"", "Gateway transfer"},
	}
	frame.auto_center = true
	frame.style.minimal_width = 360
	player.opened = frame

	local platform = resolve_platform(state)
	if not platform then
		frame.add{type = "label", caption = "This platform is no longer available."}
		local close_only = frame.add{type = "flow", direction = "horizontal"}
		close_only.add{type = "empty-widget"}.style.horizontally_stretchable = true
		close_only.add{type = "button", name = PREFIX .. "cancel", caption = "Close"}
		return
	end

	frame.add{type = "label", caption = {"", "[font=default-bold]", platform.name, "[/font] parked at [font=default-bold]", state.gateway_name, "[/font]"}}
	frame.add{type = "label", caption = "Choose a destination instance:", style = "bold_label"}

	local aboard_players, char_count = Gateway.collect_passengers(platform)
	local in_flight = SurfaceLock.is_locked(platform.index)
	local decision = GatewayGuard.evaluate{
		docked = (Gateway.parked_at_gateway(platform) == state.gateway_name),
		in_flight = in_flight,
		aboard_players = aboard_players,
		aboard_characters = char_count,
	}
	local passenger_count = decision.passenger_count

	if passenger_count > 0 then
		local warn = frame.add{type = "label", caption = {"",
			"⚠ ", tostring(passenger_count), " aboard — they will be returned to a planet when the platform transfers."}}
		warn.style.single_line = false
		warn.style.maximal_width = 340
		warn.style.font_color = COLOR_WARN
	end
	if in_flight then
		local busy = frame.add{type = "label", caption = "This platform is already transferring."}
		busy.style.font_color = COLOR_WARN
	end

	local list = frame.add{type = "flow", direction = "vertical", name = PREFIX .. "list"}
	list.style.vertical_spacing = 4
	for idx, target in ipairs(state.targets or {}) do
		local online = target.online and true or false
		local name = target.instanceName or ("instance " .. tostring(target.instanceId))
		local selected = (state.selected == idx)
		local row = list.add{type = "flow", direction = "horizontal"}
		row.style.vertical_align = "center"
		local pick = row.add{
			type = "button",
			name = PREFIX .. "target_" .. idx,
			caption = {"", (selected and "● " or "○ "), name, "  →  ", target.targetGateway or state.gateway_name},
			style = selected and "confirm_button" or "button",
		}
		pick.tags = {gw_target_idx = idx}
		pick.style.horizontally_stretchable = true
		pick.style.minimal_width = 300
		local tag = row.add{type = "label", caption = online and "online" or "offline"}
		tag.style.font_color = online and COLOR_ONLINE or COLOR_OFFLINE
		tag.style.left_margin = 8
	end

	frame.add{type = "line"}
	local footer = frame.add{type = "flow", direction = "horizontal"}
	footer.style.top_margin = 6
	footer.style.vertical_align = "center"
	footer.add{type = "button", name = PREFIX .. "cancel", caption = "Cancel"}
	footer.add{type = "empty-widget"}.style.horizontally_stretchable = true

	local can_transfer = (state.selected ~= nil) and decision.allowed
	local transfer_btn = footer.add{
		type = "button",
		name = PREFIX .. "transfer",
		caption = "Transfer",
		style = "confirm_button",
	}
	transfer_btn.enabled = can_transfer
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
		force_name = platform.force.name,
		gateway_name = gateway_name,
		targets = targets,
		selected = (#targets == 1) and 1 or nil,
	}
	open_guis[player.index] = state
	build_frame(player, state)
	return true
end

function GatewayTransferGui.close(player)
	if player and player.valid and player.gui.screen[FRAME] then
		player.gui.screen[FRAME].destroy()
	end
	if player then
		open_guis[player.index] = nil
	end
end


function GatewayTransferGui.on_gui_click(event)
	local element = event.element
	if not (element and element.valid and type(element.name) == "string") then return end
	if element.name:sub(1, #PREFIX) ~= PREFIX then return end

	local player = game.players[event.player_index]
	local state = open_guis[event.player_index]

	if element.name == PREFIX .. "cancel" then
		GatewayTransferGui.close(player)
		return
	end

	if not state then
		GatewayTransferGui.close(player)
		return
	end

	local pick_idx = element.tags and element.tags.gw_target_idx
	if pick_idx then
		state.selected = pick_idx
		build_frame(player, state)
		return
	end

	if element.name == PREFIX .. "transfer" then
		GatewayTransferGui.confirm_transfer(player, state)
		return
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

	local result = GatewayGuard.guard_and_transfer{
		docked = (gw_now == state.gateway_name),
		in_flight = SurfaceLock.is_locked(platform.index),
		aboard_players = aboard_players,
		aboard_characters = char_count,
		start_fn = function()
			return TransferTrigger.start(force, state.platform_index, target.instanceId, target.targetGateway or state.gateway_name)
		end,
	}

	if result.started then
		player.print({"", "✓ Gateway transfer started: '", platform.name, "' → ", target.instanceName or tostring(target.instanceId)})
		GatewayTransferGui.close(player)
		return
	end

	if result.reason == GatewayGuard.REASON.IN_FLIGHT then
		player.print("✗ Cannot transfer: this platform is already transferring.")
	elseif result.reason == GatewayGuard.REASON.NOT_DOCKED then
		player.print("✗ Cannot transfer: the platform is no longer parked at the gateway.")
	elseif result.start_err then
		player.print({"", "✗ Transfer failed to start: ", tostring(result.start_err)})
	else
		player.print("✗ Transfer could not start.")
	end
	if open_guis[player.index] then
		build_frame(player, state)
	end
end

function GatewayTransferGui.on_gui_closed(event)
	local element = event.element
	if element and element.valid and element.name == FRAME then
		GatewayTransferGui.close(game.players[event.player_index])
	end
end

return GatewayTransferGui
