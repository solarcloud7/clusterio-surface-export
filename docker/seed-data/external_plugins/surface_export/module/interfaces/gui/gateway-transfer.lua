-- FactorioSurfaceExport - Gateway transfer chooser GUI (Model A)
--
-- The on-arrival chooser. A platform parks at a gateway; this frame lists the destination instances that
-- gateway is linked to (controller-sourced config in storage.surface_export_config.gateways[gw].targets,
-- pushed by WS2) by their LIVE instance name, and the player picks one. Factorio has no runtime API to
-- relabel a schedule stop, so a GUI is the only way to show live, one-to-many destinations — hence Model A.
--
-- Opening is side-effect-free (safe to draw): the actual transfer fires later, on the Transfer click, in a
-- separate tick. The Transfer click re-runs the full GatewayGuard gate (never trusts the rendered state) and
-- only then calls TransferTrigger.start. The passenger HARD BLOCK (see gateway-guard.lua) is enforced there.
--
-- Targets carry the controller's camelCase field names (instanceId / instanceName / targetGateway / online)
-- — the SAME shape applyGatewaysToLua pushes, so there is no second per-field map to drift.

local Gateway = require("modules/surface_export/core/gateway")
local GatewayGuard = require("modules/surface_export/core/gateway-guard")
local TransferTrigger = require("modules/surface_export/core/transfer-trigger")
local SurfaceLock = require("modules/surface_export/utils/surface-lock")

local GatewayTransferGui = {}

local FRAME = "surfexp_gateway_frame"
local PREFIX = "surfexp_gw_"            -- all our element names start with this

-- Module-local per-player open state (runtime only — never serialized).
-- player.index -> { platform_index, force_name, gateway_name, targets, selected }
local open_guis = {}

local COLOR_ONLINE = {r = 0.4, g = 1.0, b = 0.4}
local COLOR_OFFLINE = {r = 0.9, g = 0.6, b = 0.3}
local COLOR_WARN = {r = 1.0, g = 0.5, b = 0.4}

-- ============================================================================
-- Passenger detection (the safety-critical inputs — verified on 2.0.76)
-- ============================================================================

-- Passenger detection (the safety-critical input) lives in core/gateway.lua (Gateway.collect_passengers)
-- as the single source of truth — shared by this chooser, the guard, AND the backend HARD BLOCK in
-- ExportPipeline.queue / TransferTrigger.start. Call it directly; no GUI-local wrapper.

-- ============================================================================
-- Rendering
-- ============================================================================

--- Resolve the live platform for an open-state, or nil if it vanished/moved.
local function resolve_platform(state)
	local force = state and game.forces[state.force_name]
	if not force then return nil end
	local platform = force.platforms[state.platform_index]
	if not (platform and platform.valid) then return nil end
	return platform
end

--- (Re)build the frame body from the current state. Reads passenger/lock state and runs it through the
--- SIDE-EFFECT-FREE GatewayGuard.evaluate to set the Transfer button's enabled-ness (no side effects).
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
	-- Esc / E closes it → on_gui_closed (leaves the platform parked + re-openable).
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

	-- Passenger + lock state, gated through the SIDE-EFFECT-FREE GatewayGuard.evaluate so the Transfer
	-- button reflects the SAME rules the backend enforces — add a block reason to evaluate() and the button
	-- disables automatically, with no second copy of the gate to drift here.
	local aboard_players, char_count = Gateway.collect_passengers(platform)
	local in_flight = SurfaceLock.is_locked(platform.name)
	local decision = GatewayGuard.evaluate{
		docked = (Gateway.parked_at_gateway(platform) == state.gateway_name),
		in_flight = in_flight,
		aboard_players = aboard_players,
		aboard_characters = char_count,
	}
	local passenger_count = decision.passenger_count

	if passenger_count > 0 then
		local warn = frame.add{type = "label", caption = {"",
			"⚠ ", tostring(passenger_count), " aboard — they must leave the platform before it can transfer. "
			.. "(At a gateway there is no planet to disembark onto; route the platform to a planet to drop them off.)"}}
		warn.style.single_line = false
		warn.style.maximal_width = 340
		warn.style.font_color = COLOR_WARN
	end
	if in_flight then
		local busy = frame.add{type = "label", caption = "This platform is already transferring."}
		busy.style.font_color = COLOR_WARN
	end

	-- Target list — selectable rows.
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
		-- `online` is an advisory snapshot — show it, don't gate on it.
		local tag = row.add{type = "label", caption = online and "online" or "offline"}
		tag.style.font_color = online and COLOR_ONLINE or COLOR_OFFLINE
		tag.style.left_margin = 8
	end

	-- Footer: Cancel + Transfer.
	frame.add{type = "line"}
	local footer = frame.add{type = "flow", direction = "horizontal"}
	footer.style.top_margin = 6
	footer.style.vertical_align = "center"
	footer.add{type = "button", name = PREFIX .. "cancel", caption = "Cancel"}
	footer.add{type = "empty-widget"}.style.horizontally_stretchable = true

	-- The gate (docked / not-in-flight / no-passengers) comes from evaluate; the GUI only adds its own
	-- "a destination is selected" requirement on top.
	local can_transfer = (state.selected ~= nil) and decision.allowed
	local transfer_btn = footer.add{
		type = "button",
		name = PREFIX .. "transfer",
		caption = "Transfer",
		style = "confirm_button",
	}
	transfer_btn.enabled = can_transfer
end

-- ============================================================================
-- Public API
-- ============================================================================

--- Open the chooser for a platform parked at a gateway. Reads the gateway's configured targets; if the
--- gateway has none, prints a hint and does NOT open an empty frame. Pre-selects the sole target on a 1:1
--- link (the player still presses Transfer). Safe to call from an event handler — no platform mutation.
--- @param player LuaPlayer
--- @param platform LuaSpacePlatform
--- @param gateway_name string
--- @return boolean opened
function GatewayTransferGui.open(player, platform, gateway_name)
	if not (player and player.valid and platform and platform.valid) then
		return false
	end
	local cfg = storage.surface_export_config
		and storage.surface_export_config.gateways
		and storage.surface_export_config.gateways[gateway_name]
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
		selected = (#targets == 1) and 1 or nil,  -- pre-select a 1:1 link; still requires the Transfer press
	}
	open_guis[player.index] = state
	build_frame(player, state)
	return true
end

--- Close the chooser for a player (destroy frame + drop state). Leaves the platform untouched.
function GatewayTransferGui.close(player)
	if player and player.valid and player.gui.screen[FRAME] then
		player.gui.screen[FRAME].destroy()
	end
	if player then
		open_guis[player.index] = nil
	end
end

-- ============================================================================
-- Event routing (only acts on OUR elements; co-exists with other GUIs)
-- ============================================================================

function GatewayTransferGui.on_gui_click(event)
	local element = event.element
	if not (element and element.valid and type(element.name) == "string") then return end
	if element.name:sub(1, #PREFIX) ~= PREFIX then return end

	local player = game.players[event.player_index]
	local state = open_guis[event.player_index]

	-- Cancel / close.
	if element.name == PREFIX .. "cancel" then
		GatewayTransferGui.close(player)
		return
	end

	if not state then
		-- Our frame exists but we lost state (e.g. after save/load) — just close it.
		GatewayTransferGui.close(player)
		return
	end

	-- Target selection.
	local pick_idx = element.tags and element.tags.gw_target_idx
	if pick_idx then
		state.selected = pick_idx
		build_frame(player, state)
		return
	end

	-- Transfer.
	if element.name == PREFIX .. "transfer" then
		GatewayTransferGui.confirm_transfer(player, state)
		return
	end
end

--- Re-run the full gate and start the transfer if allowed. Never trusts the rendered button state.
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

	-- Re-validate "parked at this gateway right now" (the platform could have moved between open + click).
	local gw_now = Gateway.parked_at_gateway(platform)
	local aboard_players, char_count = Gateway.collect_passengers(platform)
	local force = game.forces[state.force_name]

	local result = GatewayGuard.guard_and_transfer{
		docked = (gw_now == state.gateway_name),
		in_flight = SurfaceLock.is_locked(platform.name),
		aboard_players = aboard_players,
		aboard_characters = char_count,
		eject_fn = function(p)
			-- Best-effort: at a surfaceless gateway there is nowhere to put them, so this is a notify.
			p.print({"", "⚠ '", platform.name, "' is transferring through a gateway — please leave the platform first."})
		end,
		start_fn = function()
			return TransferTrigger.start(force, state.platform_index, target.instanceId, target.targetGateway or state.gateway_name)
		end,
	}

	if result.started then
		player.print({"", "✓ Gateway transfer started: '", platform.name, "' → ", target.instanceName or tostring(target.instanceId)})
		GatewayTransferGui.close(player)
		return
	end

	-- Blocked or failed to start — explain and keep the frame open so they can fix it and retry.
	if result.reason == GatewayGuard.REASON.PASSENGERS then
		player.print({"", "✗ Cannot transfer: ", tostring(result.passenger_count), " aboard. They must leave the platform first."})
	elseif result.reason == GatewayGuard.REASON.IN_FLIGHT then
		player.print("✗ Cannot transfer: this platform is already transferring.")
	elseif result.reason == GatewayGuard.REASON.NOT_DOCKED then
		player.print("✗ Cannot transfer: the platform is no longer parked at the gateway.")
	elseif result.start_err then
		player.print({"", "✗ Transfer failed to start: ", tostring(result.start_err)})
	else
		player.print("✗ Transfer could not start.")
	end
	-- Refresh so passenger/lock state + button enabled-ness reflect reality.
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
