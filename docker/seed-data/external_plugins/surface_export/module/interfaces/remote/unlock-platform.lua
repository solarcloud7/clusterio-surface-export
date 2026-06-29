-- Remote Interface: unlock_platform
-- Unlock a platform (restore original state)

local SurfaceLock = require("modules/surface_export/utils/surface-lock")

--- Unlock a platform (restore original state). Keyed by the UNIQUE platform index — the registry recovers
--- the display name from lock_data, so no name argument is needed (unlike the delete remote, which takes the
--- name as a cross-check tripwire before tearing the surface down).
--- @param platform_index number: Unique index of the platform to unlock (the lock-registry key)
--- @return boolean, string|nil: success, error_message
local function unlock_platform(platform_index)
  return SurfaceLock.unlock_platform(platform_index)
end

return unlock_platform
