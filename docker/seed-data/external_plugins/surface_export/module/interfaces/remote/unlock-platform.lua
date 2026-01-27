-- Remote Interface: unlock_platform
-- Unlock a platform (restore original state)

local SurfaceLock = require("modules/surface_export/utils/surface-lock")

--- Unlock a platform (restore original state)
--- @param platform_name string: Name of the platform to unlock
--- @return boolean, string|nil: success, error_message
local function unlock_platform(platform_name)
  return SurfaceLock.unlock_platform(platform_name)
end

return unlock_platform
