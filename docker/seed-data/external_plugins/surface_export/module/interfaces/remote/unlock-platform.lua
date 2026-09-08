local Timing = require("modules/surface_export/utils/operation-timing")
local SurfaceLock = require("modules/surface_export/utils/surface-lock")

local function unlock_platform(platform_index_or_name, expected_name)
  local index = tonumber(platform_index_or_name)
  if not index then
    local key, err = SurfaceLock.find_lock_key_by_name(platform_index_or_name)
    if err then return false, err end
    if not key then return false, "Platform not locked: " .. tostring(platform_index_or_name) end
    index = key
  end
  return SurfaceLock.unlock_platform(index, expected_name)
end

return function(platform_index_or_name, expected_name)
 local lock = storage.locked_platforms and storage.locked_platforms[tonumber(platform_index_or_name)]
 storage.surface_export_timing_sequence = (storage.surface_export_timing_sequence or 0) + 1
 local id = "recovery_" .. storage.surface_export_timing_sequence
 Timing.begin(id, "recovery-lua", nil, lock and lock.transfer_job_id)
 local result = table.pack(Timing.scope(id, "source_unlock", unlock_platform, platform_index_or_name, expected_name))
 local failed = result[1] == false or (type(result[1]) == "string" and result[1]:sub(1, 6) == "ERROR:")
 Timing.finish(id, failed and "failed" or "completed")
 return table.unpack(result, 1, result.n)
end
