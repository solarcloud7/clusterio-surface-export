local Util = require("modules/surface_export/utils/util")
local TeleportGui = require("modules/surface_export/interfaces/gui/teleport-gui")

local function teleport_roster_update(roster_json)
	local decoded = Util.json_to_table_compat(roster_json)
	if type(decoded) ~= "table" or type(decoded.instances) ~= "table" then
		log("[Teleport] roster update did not decode to {instances=...} — keeping the previous roster")
		return { success = false, error = "roster JSON did not decode to {instances=...}" }
	end
	storage.teleport_roster = {
		instances = decoded.instances,
		updated_tick = game.tick,
	}
	TeleportGui.refresh_all()
	return { success = true, count = #decoded.instances }
end

return teleport_roster_update
