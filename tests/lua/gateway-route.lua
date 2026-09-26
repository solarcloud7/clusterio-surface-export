local root = "docker/seed-data/external_plugins/surface_export/module/"
local states = {waiting_at_station = 7, on_the_path = 3, paused = 8, no_path = 6}
local locations = {surfexp_gateway_hub = {localised_name = {"", "Transfer Gateway"}}, nauvis = {}, vulcanus = {},
	["surfexp_gateway_i_fact1"] = {localised_name = {"", "Forge"}}, ["surfexp_gateway_i_fact2"] = {localised_name = {"", "Cinder"}}}
local env = setmetatable({defines = {space_platform_state = states}, prototypes = {space_location = locations},
	storage = {}, log = function() end}, {__index = _G})
env.require = function(name)
	if name:find("core/gateway", 1, true) and not name:find("gateway-route", 1, true) then return env.Gateway end
	if name:find("route-alerts", 1, true) then return env.RouteAlertsStub end
	if name:find("surface-lock", 1, true) then return {destination_hold_owns_surface = function(_, p) return p.held == true end} end
	return {}
end
local alerts, cleared = {}, {}
env.RouteAlertsStub = {
	raise = function(p, kind, icon, reason) alerts[#alerts + 1] = {platform = p, kind = kind, icon = icon, reason = reason} end,
	clear = function(p) cleared[#cleared + 1] = p end,
}
env.Gateway = assert(loadfile(root .. "core/gateway.lua", "t", env))()
local Gateway = env.Gateway
local Route = assert(loadfile(root .. "core/gateway-route.lua", "t", env))()

local printed = {}
local function platform(location, stations, current, state)
	local records = {}
	for i, station in ipairs(stations) do records[i] = {station = station} end
	return {valid = true, name = "Hauler", paused = false, state = state or states.waiting_at_station,
		space_location = location and {name = location},
		force = {name = "player", print = function(message) printed[#printed + 1] = message end,
			is_space_location_unlocked = function(name) return name ~= "surfexp_gateway_i_fact2" end},
		get_schedule = function() return {current = current, get_records = function() return records end} end}
end

assert(Gateway.is_instance_gateway("surfexp_gateway_i_fact2"))
assert(not Gateway.is_instance_gateway("surfexp_gateway_hub") and not Gateway.is_instance_gateway("surfexp_gateway_i_ghost"))
assert(Gateway.reached_instance_gateway(platform("surfexp_gateway_i_fact2", {"surfexp_gateway_i_fact2", "nauvis"}, 1)) == "surfexp_gateway_i_fact2")
assert(not Gateway.reached_instance_gateway(platform("surfexp_gateway_hub", {"surfexp_gateway_i_fact2"}, 1)), "passing through the hub is not an arrival")
assert(not Gateway.reached_instance_gateway(platform("surfexp_gateway_i_fact2", {"nauvis", "surfexp_gateway_i_fact2"}, 1)),
	"a destination that is not the current stop does not trigger")
assert(not Gateway.reached_instance_gateway(platform("surfexp_gateway_i_fact2", {"surfexp_gateway_i_fact2"}, 1, states.on_the_path)))
assert(not Gateway.reached_instance_gateway(platform("surfexp_gateway_hub", {"surfexp_gateway_hub", "nauvis"}, 1)),
	"a scheduled stop at the hub keeps the manual chooser")
print("PASS only the current stop at a server destination counts as arriving there")

env.storage.surface_export_config = {gateways = {surfexp_gateway_i_fact2 = {targets = {
	{instanceId = 22, instanceName = "fact2", targetGateway = "surfexp_gateway_hub", online = true}}}}}
local calls = {}
local function start(result)
	return function(p, force_name, gateway_name, target, initiator)
		calls[#calls + 1] = {paused = p.paused, force_name = force_name, gateway_name = gateway_name, target = target, initiator = initiator}
		return result
	end
end
local arriving = platform("surfexp_gateway_i_fact2", {"surfexp_gateway_i_fact2", "nauvis"}, 1)
assert(Route.on_arrival(arriving, start({started = true})) == true)
assert(#calls == 1 and calls[1].paused == true, "the platform is paused before the transfer starts, in the arrival tick")
assert(calls[1].target.instanceId == 22 and calls[1].target.targetGateway == "surfexp_gateway_hub" and calls[1].initiator == nil)
assert(#alerts == 0 and cleared[1] == arriving, "a started transfer clears any earlier route alert")

local held = platform("surfexp_gateway_i_fact2", {"surfexp_gateway_i_fact2"}, 1)
held.held = true
assert(Route.on_arrival(held, start({started = true})) == false and held.paused == false and #calls == 1,
	"a platform owned by a destination hold is never paused or exported by the trigger")

local passing = platform("surfexp_gateway_hub", {"surfexp_gateway_i_fact2"}, 1)
assert(Route.on_arrival(passing, start({started = true})) == false and passing.paused == false and #calls == 1,
	"a platform passing the hub keeps flying")

env.storage.surface_export_config.gateways.surfexp_gateway_i_fact2.targets[1].online = false
local offline = platform("surfexp_gateway_i_fact2", {"surfexp_gateway_i_fact2"}, 1)
assert(Route.on_arrival(offline, start({started = true})) == true and offline.paused == true and #calls == 1,
	"an offline server holds the platform instead of starting")
assert(#alerts == 1 and alerts[1].kind == "held" and alerts[1].icon == "surfexp_gateway_i_fact2" and alerts[1].reason[5] == "fact2 is offline",
	"an offline server raises a held alert on the destination icon")

env.storage.surface_export_config.gateways.surfexp_gateway_i_fact2.targets[1].online = true
local refused = platform("surfexp_gateway_i_fact2", {"surfexp_gateway_i_fact2"}, 1)
assert(Route.on_arrival(refused, start({started = false, start_err = "locked"})) == true and refused.paused == true)
assert(#alerts == 2 and alerts[2].reason[5]:find("locked", 1, true), "a refused start holds and says why")

env.storage.surface_export_config.gateways = {}
local unlinked = platform("surfexp_gateway_i_fact2", {"surfexp_gateway_i_fact2"}, 1)
assert(Route.on_arrival(unlinked, start({started = true})) == true and unlinked.paused == true and #calls == 2)
assert(alerts[3].reason[5] == "no server is linked to this destination" and #printed == 0, "holds alert instead of printing to chat")
local stuck = platform("nauvis", {"surfexp_gateway_i_fact2", "nauvis"}, 1, 6)
Route.on_no_path(stuck)
assert(alerts[4].kind == "no_path" and alerts[4].reason[5]:find("this server", 1, true), "a stop at this server's own destination raises an unreachable alert")
Route.on_no_path(platform("nauvis", {"vulcanus"}, 1, 6))
assert(#alerts == 4, "ordinary planet stops keep the engine's own handling")
print("PASS arrival pauses in the same tick and starts one guarded transfer; offline, refused and unlinked destinations hold visibly")

local unlocked = {surfexp_gateway_i_fact1 = true, surfexp_gateway_i_fact2 = false}
local force = {is_space_location_unlocked = function(name) return unlocked[name] ~= false end}
local function records(...)
	local list = {}
	for i, station in ipairs({...}) do list[i] = {station = station} end
	return list
end
local loop = {current = 1, records = records("surfexp_gateway_i_fact2", "nauvis", "surfexp_gateway_i_fact1", "vulcanus"),
	interrupts = {{name = "refuel"}}, group = "loop"}
local advanced = Gateway.advance_past_arrival(loop, force)
assert(advanced.current == 2 and Gateway.can_resume(advanced, force), "the route continues at the stop after this server's destination")
assert(#advanced.records == 4 and advanced.records[1].station == "surfexp_gateway_i_fact2", "every stop is kept so the loop survives each hop")
assert(advanced.interrupts[1].name == "refuel" and advanced.group == "loop")
loop.current = 4
loop.records = records("nauvis", "surfexp_gateway_i_fact1", "vulcanus", "surfexp_gateway_i_fact2")
advanced = Gateway.advance_past_arrival(loop, force)
assert(advanced.current == 1, "the route wraps from the last stop to the first")
assert(Gateway.advance_past_arrival({current = 3, records = records("surfexp_gateway_i_fact2", "nauvis", "surfexp_gateway_i_fact1")}, force) == nil,
	"a current stop at another server's destination is not an arrival here, so a manual transfer keeps the legacy strip")
assert(not Gateway.can_resume({current = 1, records = records("surfexp_gateway_i_fact2", "nauvis")}, force),
	"a next stop at this server's own destination holds instead of flying to no_path")
assert(Gateway.advance_past_arrival({current = 1, records = records("surfexp_gateway_i_fact2")}, force) == nil,
	"a lone destination stop keeps the legacy park")
assert(Gateway.advance_past_arrival({current = 1, records = records("surfexp_gateway_hub", "nauvis")}, force) == nil,
	"a manual hub transfer keeps the legacy strip")
print("PASS the destination advances past its own destination, keeps every record and holds before its own destination")

env.storage.surface_export_config = nil
assert(not Gateway.is_active_gateway("surfexp_gateway_i_fact1") and Gateway.is_active_gateway("surfexp_gateway_hub"),
	"before the first config push, server destinations stay locked while legacy gateways keep their default")
print("PASS server destinations stay locked until the controller lists them")

local shown, removed = {}, {}
local player = {add_custom_alert = function(entity, icon, message, on_map) shown[#shown + 1] = {entity = entity, icon = icon, message = message, on_map = on_map} end,
	remove_alert = function(filter) removed[#removed + 1] = filter end}
local hub_entity = {valid = true}
local held_platform = {valid = true, index = 5, name = "Hauler", paused = true, state = 8, hub = hub_entity}
local alert_force = {name = "player", connected_players = {player}, platforms = {[5] = held_platform}}
held_platform.force = alert_force
local alert_env = setmetatable({storage = {}, game = {forces = {player = alert_force}}, log = function() end,
	serpent = {line = function() return "" end},
	defines = {alert_type = {custom = 99}, space_platform_state = states}}, {__index = _G})
local RouteAlerts = assert(loadfile(root .. "core/route-alerts.lua", "t", alert_env))()
RouteAlerts.raise(held_platform, "held", "surfexp_gateway_i_fact2", "fact2 is offline")
assert(#shown == 1 and shown[1].entity == hub_entity and shown[1].icon.type == "space-location" and shown[1].icon.name == "surfexp_gateway_i_fact2" and shown[1].on_map)
RouteAlerts.refresh()
assert(#shown == 2 and removed[#removed].type == 99, "a held alert is re-shown while the platform stays paused")
held_platform.paused = false
RouteAlerts.refresh()
assert(#shown == 2 and next(alert_env.storage.surface_export_route_alerts) == nil, "the alert clears once the platform moves again")
RouteAlerts.raise(held_platform, "no_path", "surfexp_gateway_i_fact2", "cannot reach")
held_platform.state = states.no_path
RouteAlerts.refresh()
assert(next(alert_env.storage.surface_export_route_alerts) ~= nil, "an unreachable stop keeps its alert while the platform has no path")
held_platform.name = "Replacement"
RouteAlerts.refresh()
assert(next(alert_env.storage.surface_export_route_alerts) == nil, "a reused platform index does not inherit another platform's alert")
print("PASS route holds raise map alerts on the hub, refresh while they apply and clear when the platform moves")
