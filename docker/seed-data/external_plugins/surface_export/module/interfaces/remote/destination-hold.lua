-- Remote Interface: destination_hold
-- Debug/proof wrapper for the Phase-2 destination hold primitive.

local DestinationHold = require("modules/surface_export/core/destination-hold")

local function find_platform(platform_index, force_name)
	local selected_force_name = force_name or "player"
	local force = game.forces[selected_force_name]
	if not (force and force.valid) then
		return nil, nil, "Force not found: " .. tostring(selected_force_name)
	end
	local idx = tonumber(platform_index)
	if not idx then
		return nil, nil, "platform_index must be numeric"
	end
	local platform = force.platforms[idx]
	if platform and platform.valid and platform.index == idx then
		return platform, force, nil
	end
	return nil, force, "Platform index not found: " .. tostring(platform_index)
end

--- Execute a destination-hold action.
--- @param action string: "stage", "go_live", "discard", or "get"
--- @param transfer_id string
--- @param platform_index number|nil: required for "stage"
--- @param force_name string|nil
--- @return table
local function destination_hold(action, transfer_id, platform_index, force_name)
	if type(action) ~= "string" then
		return { success = false, error = "action is required" }
	end
	if type(transfer_id) ~= "string" or transfer_id == "" then
		return { success = false, error = "transfer_id is required" }
	end

	if action == "stage" then
		local platform, force, err = find_platform(platform_index, force_name)
		if err then return { success = false, error = err } end
		local ok, result = DestinationHold.stage(transfer_id, platform, force)
		if not ok then return { success = false, error = result } end
		return { success = true, hold = result }
	elseif action == "go_live" then
		local ok, result = DestinationHold.go_live(transfer_id)
		if not ok then return { success = false, error = result } end
		return { success = true, result = result }
	elseif action == "discard" then
		local ok, result = DestinationHold.discard(transfer_id)
		if not ok then return { success = false, error = result } end
		return { success = true, result = result }
	elseif action == "get" then
		return { success = true, hold = DestinationHold.get(transfer_id) }
	end

	return { success = false, error = "unknown action: " .. tostring(action) }
end

return destination_hold
