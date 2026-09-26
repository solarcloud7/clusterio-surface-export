local root = "docker/seed-data/external_plugins/surface_export/module/"
local states = {waiting_at_station = 7, on_the_path = 3, paused = 8}
local locations = {surfexp_gateway_hub = {localised_name = {"", "Transfer Gateway"}}, nauvis = {}, vulcanus = {},
	["surfexp_gateway_i_fact1"] = {localised_name = {"", "Forge"}}, ["surfexp_gateway_i_fact2"] = {localised_name = {"", "Cinder"}}}
local env = setmetatable({defines = {space_platform_state = states}, prototypes = {space_location = locations},
	storage = {}, log = function() end}, {__index = _G})
env.require = function(name)
	if name:find("core/gateway", 1, true) and not name:find("gateway-route", 1, true) then return env.Gateway end
	return {}
end
env.Gateway = assert(loadfile(root .. "core/gateway.lua", "t", env))()
local Gateway = env.Gateway
local Route = assert(loadfile(root .. "core/gateway-route.lua", "t", env))()

local printed = {}
local function platform(location, stations, current, state)
	local records = {}
	for i, station in ipairs(stations) do records[i] = {station = station} end
	return {valid = true, name = "Hauler", paused = false, state = state or states.waiting_at_station,
		space_location = location and {name = location},
		force = {name = "player", print = function(message) printed[#printed + 1] = message end},
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
assert(#printed == 0)

local passing = platform("surfexp_gateway_hub", {"surfexp_gateway_i_fact2"}, 1)
assert(Route.on_arrival(passing, start({started = true})) == false and passing.paused == false and #calls == 1,
	"a platform passing the hub keeps flying")

env.storage.surface_export_config.gateways.surfexp_gateway_i_fact2.targets[1].online = false
local offline = platform("surfexp_gateway_i_fact2", {"surfexp_gateway_i_fact2"}, 1)
assert(Route.on_arrival(offline, start({started = true})) == true and offline.paused == true and #calls == 1,
	"an offline server holds the platform instead of starting")
assert(#printed == 1 and printed[1][9] == "fact2 is offline")

env.storage.surface_export_config.gateways.surfexp_gateway_i_fact2.targets[1].online = true
local refused = platform("surfexp_gateway_i_fact2", {"surfexp_gateway_i_fact2"}, 1)
assert(Route.on_arrival(refused, start({started = false, start_err = "locked"})) == true and refused.paused == true)
assert(#printed == 2 and printed[2][9]:find("locked", 1, true), "a refused start holds and says why")

env.storage.surface_export_config.gateways = {}
local unlinked = platform("surfexp_gateway_i_fact2", {"surfexp_gateway_i_fact2"}, 1)
assert(Route.on_arrival(unlinked, start({started = true})) == true and unlinked.paused == true and #calls == 2)
assert(printed[3][9] == "no server is linked to this destination")
print("PASS arrival pauses in the same tick and starts one guarded transfer; offline, refused and unlinked destinations hold visibly")

local unlocked = {surfexp_gateway_i_fact1 = true, surfexp_gateway_i_fact2 = false}
local force = {is_space_location_unlocked = function(name) return unlocked[name] ~= false end}
local loop = {current = 1, records = {{station = "surfexp_gateway_i_fact2"}, {station = "nauvis"}, {station = "surfexp_gateway_i_fact1"}, {station = "vulcanus"}},
	interrupts = {{name = "refuel"}}, group = "loop"}
local advanced, resume = Gateway.advance_past_arrival(loop, force)
assert(advanced.current == 2 and resume == true, "the route continues at the stop after the destination")
assert(#advanced.records == 4 and advanced.records[1].station == "surfexp_gateway_i_fact2", "every stop is kept so the loop survives each hop")
assert(advanced.interrupts[1].name == "refuel" and advanced.group == "loop")
loop.current = 3
advanced, resume = Gateway.advance_past_arrival(loop, force)
assert(advanced.current == 4 and resume == true)
loop.current = 4
loop.records[4] = {station = "surfexp_gateway_i_fact1"}
loop.records[1] = {station = "surfexp_gateway_i_fact2"}
advanced, resume = Gateway.advance_past_arrival(loop, force)
assert(advanced.current == 1 and resume == false, "a next stop at this server's own destination holds instead of looping on no_path")
assert(Gateway.advance_past_arrival({current = 1, records = {{station = "surfexp_gateway_i_fact2"}}}, force) == nil,
	"a lone destination stop keeps the legacy park")
assert(Gateway.advance_past_arrival({current = 1, records = {{station = "surfexp_gateway_hub"}, {station = "nauvis"}}}, force) == nil,
	"a manual hub transfer keeps the legacy strip")
print("PASS the destination advances past the reached stop, keeps every record and holds before its own destination")
