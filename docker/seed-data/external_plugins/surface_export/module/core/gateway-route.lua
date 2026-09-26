local Gateway = require("modules/surface_export/core/gateway")

local GatewayRoute = {}

local function hold(platform, gateway_name, reason)
	local proto = prototypes.space_location[gateway_name]
	log(string.format("[Gateway] Route hold: platform '%s' at '%s': %s", platform.name, gateway_name, reason))
	platform.force.print({"", "[img=space-location/", gateway_name, "] ", platform.name, " is holding at ",
		proto and proto.localised_name or gateway_name, ": ", reason})
end

function GatewayRoute.on_arrival(platform, start_transfer)
	local gateway_name = Gateway.reached_instance_gateway(platform)
	if not gateway_name then return false end
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
		log(string.format("[Gateway] Route transfer started: platform '%s' at '%s' -> instance %s",
			platform.name, gateway_name, tostring(target.instanceId)))
		return true
	end
	hold(platform, gateway_name, "the transfer could not start (" .. tostring(result.start_err or result.reason or "unknown") .. ")")
	return true
end

return GatewayRoute
