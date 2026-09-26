local Gateway = require("modules/surface_export/core/gateway")
local SurfaceLock = require("modules/surface_export/utils/surface-lock")
local RouteAlerts = require("modules/surface_export/core/route-alerts")

local GatewayRoute = {}

local function hold(platform, gateway_name, reason)
	local proto = prototypes.space_location[gateway_name]
	log(string.format("[Gateway] Route hold: platform '%s' at '%s': %s", platform.name, gateway_name, reason))
	RouteAlerts.raise(platform, "held", gateway_name, {"", "holding at ", proto and proto.localised_name or gateway_name, ": ", reason})
end

function GatewayRoute.on_arrival(platform, start_transfer)
	local gateway_name = Gateway.reached_instance_gateway(platform)
	if not gateway_name then return false end
	if SurfaceLock.destination_hold_owns_surface(platform.surface, platform) then return false end
	platform.paused = true
	local cfg = Gateway.get_gateway_config(gateway_name)
	local target = cfg and cfg.targets and cfg.targets[1]
	if not target then
		hold(platform, gateway_name, "no server is linked to this destination")
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
	if not Gateway.is_instance_gateway(station) then return end
	local proto = prototypes.space_location[station]
	local own = not platform.force.is_space_location_unlocked(station)
	RouteAlerts.raise(platform, "no_path", station, {"", "cannot reach ", proto and proto.localised_name or station, ": ",
		own and "that destination is this server; remove the stop or skip it" or "no route from here"})
end

return GatewayRoute
