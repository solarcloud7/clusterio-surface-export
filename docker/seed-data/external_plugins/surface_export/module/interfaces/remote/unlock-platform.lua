-- Remote Interface: unlock_platform
-- Unlock a platform (restore original state)

local SurfaceLock = require("modules/surface_export/utils/surface-lock")

--- Unlock a platform (restore original state). Accepts the UNIQUE platform index (preferred — the registry
--- key) OR a platform NAME (back-compat with the documented `remote.call("surface_export","unlock_platform",
--- platform_name)` contract). A numeric arg is the index; a non-numeric arg is resolved to its lock key by
--- name (fail-loud on ambiguity). The registry recovers the display name from lock_data either way.
--- @param platform_index_or_name number|string: Unique index (preferred) or platform name
--- @return boolean, string|nil: success, error_message
local function unlock_platform(platform_index_or_name)
  local index = tonumber(platform_index_or_name)
  if not index then
    -- Name form: resolve to the registry key. Errors loudly on ambiguity (two locks share the name).
    local key, err = SurfaceLock.find_lock_key_by_name(platform_index_or_name)
    if err then return false, err end
    if not key then return false, "Platform not locked: " .. tostring(platform_index_or_name) end
    index = key
  end
  return SurfaceLock.unlock_platform(index)
end

return unlock_platform
