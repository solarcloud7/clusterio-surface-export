local root = "docker/seed-data/external_plugins/surface_export/module/"
local states = {waiting_at_station = 7, on_the_path = 3, paused = 8, no_path = 6}
local function portal_name(slot) return {"space-location-name.surfexp_gateway_" .. slot} end
local locations = {surfexp_gateway_hub = {localised_name = {"", "Gateway"}}, nauvis = {}, vulcanus = {},
	surfexp_gateway_1 = {localised_name = portal_name(1)}, surfexp_gateway_2 = {localised_name = portal_name(2)},
	surfexp_gateway_3 = {localised_name = portal_name(3)}, surfexp_gateway_4 = {localised_name = portal_name(4)},
	surfexp_gateway_5 = {}, surfexp_gateway_i_22 = {}}
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
		force = {name = "player", print = function(message) printed[#printed + 1] = message end},
		get_schedule = function() return {current = current, get_records = function() return records end} end}
end

local function server(id, name, online)
	return {instanceId = id, instanceName = name, targetGateway = "surfexp_gateway_hub", online = online}
end
local function configure(online)
	env.storage.surface_export_config = {gateways = {
		surfexp_gateway_hub = {targets = {server(22, "Delta", online), server(44, "Omega", true)}},
		surfexp_gateway_1 = {targets = {server(22, "Delta", online)}},
		surfexp_gateway_3 = {targets = {}, own = true},
		surfexp_gateway_4 = {targets = {server(44, "Omega", true)}},
	}}
end
configure(true)

for slot = 1, 4 do assert(Gateway.portal_slot("surfexp_gateway_" .. slot) == slot and Gateway.is_portal("surfexp_gateway_" .. slot)) end
assert(not Gateway.is_portal("surfexp_gateway_hub") and not Gateway.is_portal("surfexp_gateway_5"), "only the four coloured portals are portals")
assert(not Gateway.is_portal("surfexp_gateway_i_22") and not Gateway.is_portal("nauvis") and not Gateway.is_portal(nil))
assert(Gateway.own_portal() == "surfexp_gateway_3" and Gateway.is_own_portal("surfexp_gateway_3"))
assert(not Gateway.is_own_portal("surfexp_gateway_1") and not Gateway.is_own_portal("surfexp_gateway_2"))
assert(Gateway.portal_target("surfexp_gateway_1").instanceId == 22, "a portal leads to the server holding its colour")
assert(Gateway.portal_target("surfexp_gateway_3") == nil and Gateway.portal_target("surfexp_gateway_2") == nil,
	"this server's own colour and an unassigned colour lead nowhere")
assert(Gateway.portal_target("surfexp_gateway_hub") == nil, "the Gateway is not a portal")
local label = Gateway.location_label("surfexp_gateway_1")
assert(label[2] == locations.surfexp_gateway_1.localised_name and label[3] == " → " and label[4] == "Delta", "a portal's label names where it leads")
assert(Gateway.location_label("surfexp_gateway_3") == locations.surfexp_gateway_3.localised_name, "this server's own portal names no destination")
assert(Gateway.location_label("surfexp_gateway_hub") == locations.surfexp_gateway_hub.localised_name)
assert(Gateway.find_target(44).instanceName == "Omega" and Gateway.find_target(99) == nil, "alert links find a server by instance id")
print("PASS the four coloured portals: own colour, other servers' colours and unassigned colours")

assert(Gateway.reached_portal(platform("surfexp_gateway_1", {"surfexp_gateway_1", "nauvis"}, 1)) == "surfexp_gateway_1")
assert(not Gateway.reached_portal(platform("surfexp_gateway_hub", {"surfexp_gateway_1"}, 1)), "passing through the hub is not an arrival")
assert(not Gateway.reached_portal(platform("surfexp_gateway_1", {"nauvis", "surfexp_gateway_1"}, 1)),
	"a portal that is not the current stop does not trigger")
assert(not Gateway.reached_portal(platform("surfexp_gateway_1", {"surfexp_gateway_1"}, 1, states.on_the_path)))
assert(not Gateway.reached_portal(platform("surfexp_gateway_hub", {"surfexp_gateway_hub", "nauvis"}, 1)),
	"a scheduled stop at the hub keeps the manual chooser")
print("PASS only the current stop at a coloured portal counts as arriving there")

local calls = {}
local function start(result)
	return function(p, force_name, gateway_name, target, initiator)
		calls[#calls + 1] = {paused = p.paused, force_name = force_name, gateway_name = gateway_name, target = target, initiator = initiator}
		return result
	end
end
local arriving = platform("surfexp_gateway_1", {"surfexp_gateway_1", "nauvis"}, 1)
assert(Route.on_arrival(arriving, start({started = true})) == true)
assert(#calls == 1 and calls[1].paused == true, "the platform is paused before the transfer starts, in the arrival tick")
assert(calls[1].target.instanceId == 22 and calls[1].target.targetGateway == "surfexp_gateway_hub" and calls[1].initiator == nil)
assert(calls[1].gateway_name == "surfexp_gateway_1")
assert(#alerts == 0 and cleared[1] == arriving, "a started transfer clears any earlier route alert")

local held = platform("surfexp_gateway_1", {"surfexp_gateway_1"}, 1)
held.held = true
assert(Route.on_arrival(held, start({started = true})) == false and held.paused == false and #calls == 1,
	"a platform owned by a destination hold is never paused or exported by the trigger")

local passing = platform("surfexp_gateway_hub", {"surfexp_gateway_1"}, 1)
assert(Route.on_arrival(passing, start({started = true})) == false and passing.paused == false and #calls == 1,
	"a platform passing the hub keeps flying")

configure(false)
local offline = platform("surfexp_gateway_1", {"surfexp_gateway_1"}, 1)
assert(Route.on_arrival(offline, start({started = true})) == true and offline.paused == true and #calls == 1,
	"an offline server holds the platform instead of starting")
assert(#alerts == 1 and alerts[1].kind == "held" and alerts[1].icon == "surfexp_gateway_1" and alerts[1].reason[5] == "Delta is offline",
	"an offline server raises a held alert on the portal icon")
assert(alerts[1].reason[3][4] == "Delta", "the held alert says where the portal leads")

configure(true)
local refused = platform("surfexp_gateway_1", {"surfexp_gateway_1"}, 1)
assert(Route.on_arrival(refused, start({started = false, start_err = "locked"})) == true and refused.paused == true)
assert(#alerts == 2 and alerts[2].reason[5]:find("locked", 1, true), "a refused start holds and says why")

local unassigned = platform("surfexp_gateway_2", {"surfexp_gateway_2"}, 1)
assert(Route.on_arrival(unassigned, start({started = true})) == true and unassigned.paused == true and #calls == 2)
assert(alerts[3].reason[5] == "no server has this portal's colour" and #printed == 0, "holds alert instead of printing to chat")
local own = platform("surfexp_gateway_3", {"surfexp_gateway_3"}, 1)
assert(Route.on_arrival(own, start({started = true})) == true and own.paused == true and #calls == 2,
	"a platform at this server's own portal is held, never sent")
assert(alerts[4].reason[5]:find("this server's own", 1, true))

Route.on_no_path(platform("nauvis", {"surfexp_gateway_3", "nauvis"}, 1, states.no_path))
assert(alerts[5].kind == "no_path" and alerts[5].icon == "surfexp_gateway_3" and alerts[5].reason[5]:find("this server's own", 1, true),
	"a stop at this server's own portal raises an unreachable alert")
Route.on_no_path(platform("nauvis", {"surfexp_gateway_2"}, 1, states.no_path))
assert(alerts[6].reason[5] == "no server has that portal's colour")
Route.on_no_path(platform("nauvis", {"surfexp_gateway_1"}, 1, states.no_path))
assert(alerts[7].reason[5] == "no route from here" and alerts[7].reason[3][4] == "Delta")
Route.on_no_path(platform("nauvis", {"vulcanus"}, 1, states.no_path))
assert(#alerts == 7, "ordinary planet stops keep the engine's own handling")
print("PASS arrival pauses in the same tick and starts one guarded transfer; offline, refused, unassigned and own portals hold visibly")

local function records(...)
	local list = {}
	for i, station in ipairs({...}) do list[i] = {station = station} end
	return list
end
local loop = {current = 1, records = records("surfexp_gateway_3", "nauvis", "surfexp_gateway_1", "vulcanus"),
	interrupts = {{name = "refuel"}}, group = "loop"}
local advanced = Gateway.advance_past_arrival(loop)
assert(advanced.current == 2 and Gateway.can_resume(advanced), "the route continues at the stop after this server's own portal")
assert(#advanced.records == 4 and advanced.records[1].station == "surfexp_gateway_3", "every stop is kept so the loop survives each hop")
assert(advanced.interrupts[1].name == "refuel" and advanced.group == "loop")
loop.current = 4
loop.records = records("nauvis", "surfexp_gateway_1", "vulcanus", "surfexp_gateway_3")
advanced = Gateway.advance_past_arrival(loop)
assert(advanced.current == 1, "the route wraps from the last stop to the first")
assert(Gateway.advance_past_arrival({current = 3, records = records("surfexp_gateway_3", "nauvis", "surfexp_gateway_1")}) == nil,
	"a current stop at another server's portal is not an arrival here, so a manual transfer keeps the legacy strip")
assert(Gateway.advance_past_arrival({current = 1, records = records("surfexp_gateway_2", "nauvis")}) == nil,
	"an unassigned portal is not this server's own")
assert(not Gateway.can_resume({current = 1, records = records("surfexp_gateway_3", "nauvis")}),
	"a next stop at this server's own portal holds instead of flying to no_path")
assert(Gateway.can_resume({current = 1, records = records("surfexp_gateway_1", "nauvis")}), "a next stop at another server's portal resumes")
assert(Gateway.advance_past_arrival({current = 1, records = records("surfexp_gateway_3")}) == nil,
	"a lone portal stop keeps the legacy park")
assert(Gateway.advance_past_arrival({current = 1, records = records("surfexp_gateway_hub", "nauvis")}) == nil,
	"a manual hub transfer keeps the legacy strip")
print("PASS the destination advances past its own portal, keeps every record and holds before its own portal")

env.storage.surface_export_config = nil
assert(Gateway.own_portal() == nil, "before its first config a server does not know its own portal")
local unconfigured = {current = 1, records = records("surfexp_gateway_3", "nauvis", "surfexp_gateway_1", "vulcanus"),
	interrupts = {{name = "refuel"}}, group = "loop"}
advanced = Gateway.advance_past_arrival(unconfigured, "surfexp_gateway_3")
assert(advanced and advanced.current == 2 and #advanced.records == 4 and advanced.records[1].station == "surfexp_gateway_3",
	"the portal the platform reached decides the arrival, with or without config, and every stop is kept")
assert(advanced.interrupts[1].name == "refuel" and advanced.group == "loop")
assert(Gateway.advance_past_arrival(unconfigured) == nil, "without the reached portal and without config nothing advances")
assert(Gateway.advance_past_arrival(unconfigured, "surfexp_gateway_1") == nil, "a different reached portal is not this stop")
configure(true)
assert(Gateway.advance_past_arrival({current = 1, records = records("surfexp_gateway_1", "nauvis")}, "surfexp_gateway_1").current == 2,
	"the reached portal wins over the own-colour config")
assert(Gateway.advance_past_arrival({current = 1, records = records("surfexp_gateway_3", "nauvis")}, "surfexp_gateway_1") == nil,
	"a reached portal that is not the current stop is not an arrival, even at this server's own colour")
print("PASS the reached portal carried by the transfer decides the arrival without depending on config")

env.storage.surface_export_config = nil
local route_loop = function() return {current = 1, records = records("surfexp_gateway_3", "nauvis", "surfexp_gateway_1"), interrupts = {}} end
local routed, arrival = Gateway.route_schedule("surfexp_gateway_hub", route_loop(), "surfexp_gateway_3")
assert(arrival == true and routed.current == 2 and #routed.records == 3, "a portal arrival keeps the loop")
routed, arrival = Gateway.route_schedule("surfexp_gateway_hub", route_loop())
assert(arrival == false and #routed.records == 1 and routed.records[1].station == "nauvis",
	"a manual or older transfer without a reached portal keeps the legacy strip")
routed, arrival = Gateway.route_schedule("surfexp_gateway_hub", {current = 1, records = records("vulcanus", "surfexp_gateway_3", "nauvis")}, "vulcanus")
assert(arrival == false and #routed.records == 2 and routed.records[1].station == "vulcanus", "a reached portal that is not a portal here is ignored")
local lone = {current = 1, records = records("surfexp_gateway_3")}
routed, arrival = Gateway.route_schedule("surfexp_gateway_hub", lone, "surfexp_gateway_2")
assert(arrival == false and routed == lone, "a gateway-only schedule is kept")
local untouched = route_loop()
routed, arrival = Gateway.route_schedule(nil, untouched, "surfexp_gateway_3")
assert(arrival == false and routed == untouched, "a transfer that does not park at a gateway keeps its schedule")
routed, arrival = Gateway.route_schedule("nauvis", untouched, "surfexp_gateway_3")
assert(arrival == false and routed == untouched, "a planet park keeps its schedule")
assert(Gateway.arrival_park(nil, "surfexp_gateway_2") == "surfexp_gateway_hub", "a portal park target arrives at the Gateway")
assert(Gateway.arrival_park("surfexp_gateway_4", nil) == "surfexp_gateway_hub")
assert(Gateway.arrival_park(nil, "surfexp_gateway_hub") == "surfexp_gateway_hub")
assert(Gateway.arrival_park(nil, "nauvis") == nil, "a gateway target that is not a gateway here is ignored")
assert(Gateway.arrival_park(nil, nil) == nil)
assert(Gateway.arrival_park("vulcanus", "surfexp_gateway_hub") == "vulcanus", "an explicit park request wins")
print("PASS portal park targets arrive at the Gateway and route arrivals keep their loop")

assert(Gateway.is_active_gateway("surfexp_gateway_hub"), "the Gateway is open before the first config push")
for slot = 1, 4 do
	assert(not Gateway.is_active_gateway("surfexp_gateway_" .. slot), "portal " .. slot .. " stays locked until the controller lists it")
end
env.storage.surface_export_config = {active_gateways = {"surfexp_gateway_hub", "surfexp_gateway_1"}}
assert(Gateway.is_active_gateway("surfexp_gateway_1") and not Gateway.is_active_gateway("surfexp_gateway_3"))
print("PASS portals stay locked until the controller lists them")

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
RouteAlerts.raise(held_platform, "held", "surfexp_gateway_1", "fact2 is offline")
assert(#shown == 1 and shown[1].entity == hub_entity and shown[1].icon.type == "space-location" and shown[1].icon.name == "surfexp_gateway_1" and shown[1].on_map)
RouteAlerts.refresh()
assert(#shown == 2 and removed[#removed].type == 99, "a held alert is re-shown while the platform stays paused")
held_platform.paused = false
RouteAlerts.refresh()
assert(#shown == 2 and next(alert_env.storage.surface_export_route_alerts) == nil, "the alert clears once the platform moves again")
RouteAlerts.raise(held_platform, "no_path", "surfexp_gateway_1", "cannot reach")
held_platform.state = states.no_path
RouteAlerts.refresh()
assert(next(alert_env.storage.surface_export_route_alerts) ~= nil, "an unreachable stop keeps its alert while the platform has no path")
held_platform.name = "Replacement"
RouteAlerts.refresh()
assert(next(alert_env.storage.surface_export_route_alerts) == nil, "a reused platform index does not inherit another platform's alert")
held_platform.name = "Hauler"
RouteAlerts.raise(held_platform, "no_path", "surfexp_gateway_1", "cannot reach")
held_platform.scheduled_for_deletion = 5000
RouteAlerts.refresh()
assert(next(alert_env.storage.surface_export_route_alerts) == nil, "a platform scheduled for deletion no longer holds an alert")
held_platform.scheduled_for_deletion = 0
print("PASS route holds raise map alerts on the hub, refresh while they apply and clear when the platform moves")

local sent = {}
RouteAlerts.sender = function(payload) sent[#sent + 1] = payload end
held_platform.name, held_platform.paused, held_platform.state = "Hauler", true, states.paused
RouteAlerts.raise(held_platform, "held", "surfexp_gateway_1", "fact2 is offline")
assert(#sent == 1 and sent[1].active == true and sent[1].key == "player:5" and sent[1].platform_name == "Hauler" and sent[1].icon == "surfexp_gateway_1",
	"a raised alert is relayed so every server hears about it")
RouteAlerts.refresh()
assert(#sent == 2 and sent[2].active == true, "an alert that still applies is re-announced as a keep-alive")
held_platform.paused = false
RouteAlerts.refresh()
assert(#sent == 3 and sent[3].active == false, "a cleared alert is relayed as cleared")
RouteAlerts.raise(held_platform, "held", "surfexp_gateway_1", "offline")
held_platform.valid = false
RouteAlerts.refresh()
assert(sent[#sent].active == false, "a deleted platform's alert is relayed as cleared")
held_platform.valid = true
RouteAlerts.sender = nil

local character = {valid = true}
player.character = character
local printed_remote = {}
alert_force.print = function(message) printed_remote[#printed_remote + 1] = message end
alert_env.prototypes = {space_location = {surfexp_gateway_1 = {}, surfexp_gateway_hub = {}}}
alert_env.game.tick = 100
shown = {}
RouteAlerts.receive({key = "player:9", platformName = "Barge", forceName = "player", icon = "surfexp_gateway_1",
	active = true, reason = "cannot reach", sourceInstanceId = 22, sourceName = "Forge"})
assert(#shown == 1 and shown[1].entity == character and shown[1].on_map == false and shown[1].message[4] == "Forge",
	"another server's alert shows natively, pinned to the player with no map marker")
assert(#printed_remote == 1 and printed_remote[1][7] == "surfexp_route_" and printed_remote[1][8] == "22", "the first sighting prints one chat line with a GPS link")
RouteAlerts.receive({key = "player:9", platformName = "Barge", forceName = "player", icon = "gone-planet",
	active = true, reason = "cannot reach", sourceInstanceId = 22, sourceName = "Forge"})
assert(#printed_remote == 1 and shown[#shown].icon.name == "surfexp_gateway_hub", "keep-alives do not repeat the chat line; unknown icons fall back to the hub")
assert(RouteAlerts.server_from_gps("surfexp_route_22") == 22 and RouteAlerts.server_from_gps("nauvis") == nil)
alert_env.game.tick = 100 + RouteAlerts.REMOTE_EXPIRY_TICKS + 1
RouteAlerts.refresh()
assert(next(alert_env.storage.surface_export_remote_route_alerts) == nil, "an alert whose server stopped announcing it expires")
alert_env.game.tick = 200
RouteAlerts.receive({key = "player:9", platformName = "Barge", forceName = "player", icon = "surfexp_gateway_1",
	active = true, reason = "cannot reach", sourceInstanceId = 22, sourceName = "Forge"})
local before = #removed
RouteAlerts.receive({key = "player:9", platformName = "Barge", forceName = "player", icon = "surfexp_gateway_1",
	active = false, sourceInstanceId = 22, sourceName = "Forge"})
assert(next(alert_env.storage.surface_export_remote_route_alerts) == nil and #removed > before, "a relayed clear removes the alert everywhere")
print("PASS route alerts are relayed to every server, shown natively there with a GPS link to the platform's server, and clear or expire")

local connects, notices = {}, {}
local clicker = {name = "tester", connect_to_server = function(options) connects[#connects + 1] = options end,
	print = function(message) notices[#notices + 1] = message end}
local allowed = false
local function is_allowed() return allowed end
local function target_for(id) return id == 22 and {address = "host:22", instanceName = "Forge"} or nil end
assert(RouteAlerts.connect_from_gps(clicker, "nauvis", is_allowed, target_for) == "ignored" and #notices == 0, "ordinary GPS links are left alone")
assert(RouteAlerts.connect_from_gps(clicker, "surfexp_route_22", is_allowed, target_for) == "refused" and #connects == 0,
	"a player without Teleport permission cannot switch servers from an alert link")
allowed = true
assert(RouteAlerts.connect_from_gps(clicker, "surfexp_route_99", is_allowed, target_for) == "unreachable" and #connects == 0)
assert(RouteAlerts.connect_from_gps(clicker, "surfexp_route_22", is_allowed, target_for) == "connected"
	and connects[1].address == "host:22" and connects[1].name == "Forge", "a permitted player gets the connect prompt for the alert's server")
print("PASS alert links open the connect prompt only for players allowed to teleport")

local announced = {}
env.game = {print = function(message) announced[#announced + 1] = message end}
env.storage = {}
local config_env_require = env.require
env.require = function(name)
	if name:find("utils/util", 1, true) then return {json_to_table_compat = function(value) return value end} end
	if name:find("interfaces/gui/gateway-transfer", 1, true) then return {refresh_open = function() end} end
	return config_env_require(name)
end
local configure = assert(loadfile(root .. "interfaces/remote/configure.lua", "t", env))()
local function push(slot1, slot2)
	configure({gateways_json = {surfexp_gateway_hub = {targets = {}}, surfexp_gateway_1 = slot1 and {targets = {slot1}} or nil,
		surfexp_gateway_2 = slot2, surfexp_gateway_3 = {targets = {}, own = true}}})
end
push(server(22, "Delta", true))
push(server(22, "Delta", false))
assert(#announced == 0, "the first config and unchanged leads announce nothing")
push(server(44, "Omega", true))
assert(#announced == 1 and announced[1][5][1] == "space-location-name.surfexp_gateway_1" and announced[1][7] == "Omega",
	"every server hears that a colour now leads elsewhere")
push(nil)
push(nil, {targets = {}, own = true})
assert(#announced == 1, "a freed colour or a colour that becomes this server's own is not a new lead")
push(server(55, "Zeta", true))
assert(#announced == 2 and announced[2][7] == "Zeta", "a freed colour taken by another server is announced")
local function push_own(slot3)
	configure({gateways_json = {surfexp_gateway_hub = {targets = {}}, surfexp_gateway_3 = slot3}})
end
push_own(nil)
assert(#announced == 2, "releasing this server's own colour announces nothing")
push_own({targets = {server(66, "Kappa", true)}})
assert(#announced == 3 and announced[3][5][1] == "space-location-name.surfexp_gateway_3" and announced[3][7] == "Kappa",
	"the former holder of a colour hears where it now leads")
env.storage.surface_export_portal_leads = nil
push_own({targets = {server(66, "Kappa", true)}})
assert(#announced == 3, "a server that never saw who held a colour announces nothing")
print("PASS a portal colour that changes holder is announced on every server")
