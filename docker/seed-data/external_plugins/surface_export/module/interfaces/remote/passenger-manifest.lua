local PassengerTransit = require("modules/surface_export/core/passenger-transit")
local PassengerArrival = require("modules/surface_export/core/passenger-arrival")

local function passenger_manifest(job_id)
	if type(job_id) ~= "string" or job_id == "" then
		return helpers.table_to_json({success = false, error = "job_id is required"})
	end
	local passengers = PassengerTransit.manifest(job_id)
	if not passengers then
		return helpers.table_to_json({success = false, error = "No source deletion receipt for " .. job_id})
	end
	return helpers.table_to_json({success = true, passengers = passengers})
end

local function passenger_manifest_stage(transfer_id, index, total, part)
	local ok, received = pcall(PassengerArrival.stage, transfer_id, index, total, part)
	if not ok then return helpers.table_to_json({ok = false, error = tostring(received)}) end
	return helpers.table_to_json({ok = true, received = received})
end

return {
	passenger_manifest = passenger_manifest,
	passenger_manifest_stage = passenger_manifest_stage,
}
