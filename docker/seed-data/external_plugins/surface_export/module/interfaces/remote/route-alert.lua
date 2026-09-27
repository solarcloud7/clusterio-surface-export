local Util = require("modules/surface_export/utils/util")
local RouteAlerts = require("modules/surface_export/core/route-alerts")

local function route_alert_remote(alert_json)
	local decoded = Util.json_to_table_compat(alert_json)
	if type(decoded) ~= "table" or type(decoded.key) ~= "string" or type(decoded.platformName) ~= "string"
		or type(decoded.sourceInstanceId) ~= "number" then
		log("[Gateway] relayed route alert did not decode to an alert")
		return { success = false, error = "route alert JSON did not decode to an alert" }
	end
	RouteAlerts.receive(decoded)
	return { success = true }
end

return route_alert_remote
