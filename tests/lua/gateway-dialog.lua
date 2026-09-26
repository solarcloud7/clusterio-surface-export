local root = "docker/seed-data/external_plugins/surface_export/module/"
local FRAME = "surfexp_gateway_frame"

local counter = 0
local function gui(parent, values)
	local element = values or {}
	counter = counter + 1
	element.valid, element.index, element.style = true, counter, {}
	element.tags = element.tags or {}
	element.children = {}
	element.enabled = element.enabled ~= false
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
local function find(element, predicate)
	for _, child in ipairs(element.children) do
		if predicate(child) then return child end
		local nested = find(child, predicate)
		if nested then return nested end
	end
end
local function named(element, name) return find(element, function(child) return child.name == name end) end
local function captioned(element, text)
	return find(element, function(child)
		if type(child.caption) == "string" then return child.caption:find(text, 1, true) ~= nil end
		if type(child.caption) == "table" then return table.concat(child.caption, ""):find(text, 1, true) ~= nil end
		return false
	end)
end

local parked, locked = "surfexp_gateway_hub", false
local gateway_targets = {{instanceId = 2, instanceName = "Two", targetGateway = "surfexp_gateway_hub", online = true}}
local platform = {valid = true, index = 7, name = "Ship", force = {name = "player"}}
local force = {name = "player", platforms = {[7] = platform}}
platform.surface = {platform = platform}
local started = {}
local passenger_calls, start_error = {}, nil
local player = {index = 1, valid = true, connected = true, physical_surface_index = 70, gui = {screen = gui()}, printed = {}}
player.print = function(message) player.printed[#player.printed + 1] = message end

local env = setmetatable({
	storage = {},
	game = {tick = 1000, forces = {player = force}, get_player = function() return player end,
		get_surface = function(index) return index == 70 and platform.surface or nil end},
	prototypes = {space_location = {surfexp_gateway_hub = {localised_name = "Gateway Hub"}}},
	helpers = {is_valid_sprite_path = function() return true end},
	log = function() end,
}, {__index = _G})
env.require = function(name)
	if name:find("platform-identity", 1, true) then return function(p) return "uid:" .. p.index end end
	if name:find("gateway-guard", 1, true) then
		return {REASON = {IN_FLIGHT = "in_flight", NOT_DOCKED = "not_docked"},
			evaluate = function(opts) return {allowed = opts.docked and not opts.in_flight, passenger_count = #opts.aboard_players} end,
			guard_and_transfer = function(opts)
				if not opts.docked or opts.in_flight then return {started = false, reason = "in_flight"} end
				return {started = opts.start_fn()}
			end}
	end
	if name:find("transfer-trigger", 1, true) then
		return {start = function(_, index, instance, gateway)
			started[#started + 1] = {index, instance, gateway, parked_before = #passenger_calls}
			if start_error == "throw" then error("injected start exception") end
			if start_error then return nil, start_error end
			return "job-" .. #started
		end}
	end
	if name:find("passenger-transit", 1, true) then
		return {
			park = function(p, target, gateway, players)
				passenger_calls[#passenger_calls + 1] = {"park", p.index, target.instanceId, gateway, #players}
				return {players[1].index}
			end,
			assign_job = function(parked_list, job) passenger_calls[#passenger_calls + 1] = {"assign", parked_list[1], job} end,
			return_parked = function(parked_list) passenger_calls[#passenger_calls + 1] = {"return", parked_list[1]} end,
		}
	end
	if name:find("surface-lock", 1, true) then return {is_locked = function() return locked end} end
	return {
		get_gateway_config = function() return {targets = gateway_targets} end,
		parked_at_gateway = function() return parked end,
		collect_passengers = function() return {player}, 0 end,
	}
end
local dialog = assert(loadfile(root .. "interfaces/gui/gateway-transfer.lua", "t", env))()

assert(dialog.open(player, platform, "surfexp_gateway_hub"))
local frame = player.gui.screen[FRAME]
assert(frame and player.opened == frame and env.storage.surface_export_gateway_dialogs[1], "open should build and persist the dialog")
assert(named(frame, "surfexp_gw_target_1").state == true, "a single online destination should be preselected")
assert(named(frame, "surfexp_gw_transfer").enabled, "Transfer should be enabled for a docked platform with a destination")
assert(named(frame, "surfexp_gw_aboard_count").caption == "× 1" and named(frame, "surfexp_gw_aboard_icon").sprite == "entity/character",
	"players aboard should be shown as a character icon and count")
assert(not captioned(frame, "returned to a planet"), "the dialog should not carry the old passenger warning")
print("PASS the dialog preselects the only online destination and shows the players aboard")

gateway_targets = {
	{instanceId = 2, instanceName = "Two", targetGateway = "surfexp_gateway_hub", online = false},
	{instanceId = 3, instanceName = "Three", targetGateway = "surfexp_gateway_hub", online = true},
}
dialog.refresh_open()
frame = player.gui.screen[FRAME]
assert(not named(frame, "surfexp_gw_target_1").enabled and captioned(frame, "Offline"), "offline destinations should be disabled")
assert(named(frame, "surfexp_gw_target_2").state == true, "the only online destination should be selected after a status push")
gateway_targets[1].online = true
dialog.refresh_open()
frame = player.gui.screen[FRAME]
assert(named(frame, "surfexp_gw_target_1").enabled and named(frame, "surfexp_gw_target_2").state == true,
	"a status push should enable the returning destination and keep the current selection")
assert(not captioned(frame, "→"), "a destination arriving at the same gateway should not repeat it")
gateway_targets[2].targetGateway = "surfexp_gateway_2"
dialog.refresh_open()
frame = player.gui.screen[FRAME]
assert(captioned(frame, "→ surfexp_gateway_2"), "a destination arriving at a different gateway should name it")
gateway_targets[2].targetGateway = "surfexp_gateway_hub"
dialog.refresh_open()
frame = player.gui.screen[FRAME]
print("PASS status pushes refresh the open dialog, disable offline destinations and keep the selection")

dialog.on_gui_click{player_index = 1, element = named(frame, "surfexp_gw_target_1")}
frame = player.gui.screen[FRAME]
assert(named(frame, "surfexp_gw_target_1").state == true and env.storage.surface_export_gateway_dialogs[1].chosen)
dialog.on_gui_click{player_index = 1, element = named(frame, "surfexp_gw_transfer")}
assert(#started == 1 and started[1][1] == 7 and started[1][2] == 2 and not player.gui.screen[FRAME], "Transfer should start the chosen destination and close")
assert(started[1].parked_before == 1 and passenger_calls[1][1] == "park" and passenger_calls[1][3] == 2 and passenger_calls[1][5] == 1,
	"passengers should be parked before the transfer starts")
assert(passenger_calls[2][1] == "assign" and passenger_calls[2][2] == 1 and passenger_calls[2][3] == "job-1",
	"the started job should be recorded on the parked passengers")
print("PASS choosing a destination and pressing Transfer starts that transfer and closes the dialog")

assert(dialog.open(player, platform, "surfexp_gateway_hub"))
parked = nil
dialog.platform_state_changed(platform)
frame = player.gui.screen[FRAME]
local state = env.storage.surface_export_gateway_dialogs[1]
assert(state.departed and state.close_tick == 1120, "leaving the gateway should schedule a close two seconds later")
assert(not named(frame, "surfexp_gw_transfer").enabled and captioned(frame, "left the gateway"), "a departed platform should not offer Transfer")
env.game.tick = 1119
dialog.on_tick()
assert(player.gui.screen[FRAME], "the dialog should stay open until two seconds have passed")
env.game.tick = 1120
dialog.on_tick()
assert(not player.gui.screen[FRAME] and not env.storage.surface_export_gateway_dialogs[1], "the dialog should close two seconds after departure")
print("PASS the dialog closes two seconds after the platform leaves the gateway")

parked = "surfexp_gateway_hub"
env.game.tick = 2000
assert(dialog.open(player, platform, "surfexp_gateway_hub"))
parked = nil
dialog.platform_state_changed(platform)
parked = "surfexp_gateway_hub"
dialog.platform_state_changed(platform)
env.game.tick = 2500
dialog.on_tick()
assert(player.gui.screen[FRAME] and not env.storage.surface_export_gateway_dialogs[1].close_tick, "returning to the gateway should cancel the close")
dialog.on_gui_click{player_index = 1, element = named(player.gui.screen[FRAME], "surfexp_gw_cancel")}
assert(not player.gui.screen[FRAME] and not env.storage.surface_export_gateway_dialogs[1], "Stay should close the dialog")
print("PASS returning to the gateway cancels the close and Stay closes the dialog")

assert(dialog.offer(player) and player.gui.screen[FRAME], "a player aboard a parked platform should be offered the dialog")
local first = player.gui.screen[FRAME]
assert(dialog.offer(player) and player.gui.screen[FRAME] == first, "an open dialog for the same platform should not be rebuilt")
dialog.close(player)
locked = true
assert(not dialog.offer(player) and not player.gui.screen[FRAME], "a transferring platform should not be offered")
locked = false
parked = nil
assert(not dialog.offer(player), "a platform away from the gateway should not be offered")
parked = "surfexp_gateway_hub"
gateway_targets = {}
assert(not dialog.offer(player), "a gateway without destinations should not be offered")
player.physical_surface_index = 71
gateway_targets = {{instanceId = 2, instanceName = "Two", online = true}}
assert(not dialog.offer(player), "a player not aboard a platform should not be offered")
print("PASS joining aboard a parked platform offers the dialog only when a transfer is possible")


player.physical_surface_index = 70
passenger_calls, start_error = {}, "injected start failure"
assert(dialog.open(player, platform, "surfexp_gateway_hub"))
dialog.on_gui_click{player_index = 1, element = named(player.gui.screen[FRAME], "surfexp_gw_transfer")}
assert(passenger_calls[1][1] == "park" and passenger_calls[2][1] == "return" and passenger_calls[2][2] == 1 and #passenger_calls == 2,
	"a transfer that fails to start should return the parked passengers and record no job")
passenger_calls, start_error = {}, nil
locked = true
dialog.on_gui_click{player_index = 1, element = named(player.gui.screen[FRAME], "surfexp_gw_transfer")}
for _, call in ipairs(passenger_calls) do assert(call[1] ~= "park" and call[2] == nil, "a refused transfer should not park anyone") end
locked = false
print("PASS passengers are parked only for an allowed transfer and returned when it fails to start")

passenger_calls, start_error = {}, "throw"
if not player.gui.screen[FRAME] then assert(dialog.open(player, platform, "surfexp_gateway_hub")) end
local threw = not pcall(dialog.on_gui_click, {player_index = 1, element = named(player.gui.screen[FRAME], "surfexp_gw_transfer")})
assert(not threw and passenger_calls[1][1] == "park" and passenger_calls[2] and passenger_calls[2][1] == "return",
	"a transfer start that raises should still return the parked passengers")
start_error = nil
print("PASS a transfer start that raises returns the parked passengers")
