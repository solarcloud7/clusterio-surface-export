local Timing = require("modules/surface_export/utils/operation-timing")

-- Fixed workloads only. No surfaces, entities, inventories, or scheduling settings are changed.
return function(action, id)
	if not storage.surface_export_config or not storage.surface_export_config.debug_mode then
		return {success = false, error = "timing_selftest requires debug_mode"}
	end
	if type(id) ~= "string" or #id > 100 or not string.match(id, "^timing%-probe%-[%w%-]+$") then
		return {success = false, error = "Invalid timing probe ID"}
	end
	local function work()
		local sum = 0
		for i = 1, 200000 do sum = sum + i end
		return sum
	end
	if action == "start" then
		Timing.begin(id, "source-lua")
		Timing.scope(id, "entities", work)
	elseif action == "finish" then
		Timing.scope(id, "entities", work)
		Timing.finish(id, "completed", {"entities"})
	elseif action == "baseline" or action == "normal" or action == "debug" or action == "cap" then
		local config = storage.surface_export_config
		local previous = config.profile_batches
		config.profile_batches = action == "debug" or action == "cap"
		local profiler = helpers.create_profiler()
		if action ~= "baseline" then Timing.begin(id, "source-lua") end
		for i = 1, (action == "cap" and 2005 or 100) do
			if action == "baseline" then work()
			elseif action == "cap" then Timing.scope(id, "entities", function() return i end)
			else Timing.scope(id, "entities", work) end
		end
		if action ~= "baseline" then Timing.finish(id, "completed", {"entities"}) end
		profiler.stop()
		config.profile_batches = previous
		log({"", "[SE_PROFILE_LAB]", id, "\t", profiler})
	else
		return {success = false, error = "Unknown timing probe action"}
	end
	return {success = true, tick = game.tick}
end
