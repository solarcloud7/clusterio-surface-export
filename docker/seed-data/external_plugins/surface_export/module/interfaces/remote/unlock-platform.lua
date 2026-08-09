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

return unlock_platform
