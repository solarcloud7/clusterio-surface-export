local DestinationHold = require("modules/surface_export/core/destination-hold")
local Receipts = require("modules/surface_export/utils/transfer-receipts")

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
	elseif action == "verify" then
		local hold = DestinationHold.get(transfer_id)
		local receipt = Receipts.get("destination_live", transfer_id)
		if receipt then
			local released, _, err = find_platform(receipt.platform_index, receipt.force_name)
			if hold or not released or not released.surface.valid or released.surface.index ~= receipt.surface_index then
				return { success = false, error = err or "Released destination identity changed or is still held" }
			end
			return { success = true }
		end
		if not hold then return { success = false, error = "Validated destination is not held" } end
		if hold.preparation_failed then return { success = false, error = "Destination preparation did not finish" } end
		local platform, _, err = find_platform(hold.platform_index, hold.force_name)
		if err or platform.surface.index ~= hold.surface_index or not platform.hidden then
			return { success = false, error = err or "Destination hold identity or visibility changed" }
		end
		return { success = true }
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
