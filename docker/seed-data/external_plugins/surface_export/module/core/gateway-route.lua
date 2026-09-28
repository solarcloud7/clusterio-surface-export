local Gateway = require("modules/surface_export/core/gateway")
local SurfaceLock = require("modules/surface_export/utils/surface-lock")
local RouteAlerts = require("modules/surface_export/core/route-alerts")

local GatewayRoute = {}

local function hold(platform, gateway_name, reason)
	log(string.format("[Gateway] Route hold: platform '%s' at '%s': %s", platform.name, gateway_name, reason))
	RouteAlerts.raise(platform, "held", gateway_name, {"", "holding at ", Gateway.location_label(gateway_name), ": ", reason})
end

function GatewayRoute.on_arrival(platform, start_transfer)
	local gateway_name = Gateway.reached_portal(platform)
	if not gateway_name then return false end
	if SurfaceLock.destination_hold_owns_surface(platform.surface, platform) then return false end
	platform.paused = true
	if Gateway.is_own_portal(gateway_name) then
		hold(platform, gateway_name, "this portal's colour is this server's own; edit the schedule and unpause it")
		return true
	end
	local target = Gateway.portal_target(gateway_name)
	if not target then
		hold(platform, gateway_name, "no server has this portal's colour")
		return true
	end
	if not target.online then
		hold(platform, gateway_name, tostring(target.instanceName) .. " is offline")
		return true
	end
	local result = start_transfer(platform, platform.force.name, gateway_name, target, nil)
	if result.started then
		RouteAlerts.clear(platform)
		log(string.format("[Gateway] Route transfer started: platform '%s' at '%s' -> instance %s",
			platform.name, gateway_name, tostring(target.instanceId)))
		return true
	end
	hold(platform, gateway_name, "the transfer could not start (" .. tostring(result.start_err or result.reason or "unknown") .. ")")
	return true
end

function GatewayRoute.on_no_path(platform)
	local schedule = platform.get_schedule()
	local record = schedule and schedule.get_records()[schedule.current]
	local station = record and record.station
	if not Gateway.is_portal(station) then return end
	local reason = "no route from here"
	if Gateway.is_own_portal(station) then
		reason = "that portal's colour is this server's own; remove the stop or skip it"
	elseif not Gateway.portal_target(station) then
		reason = "no server has that portal's colour"
	end
	RouteAlerts.raise(platform, "no_path", station, {"", "cannot reach ", Gateway.location_label(station), ": ", reason})
end

return GatewayRoute
