-- Remote Interface: lock_platform_for_transfer
-- Lock a platform for transfer (prevents modifications)

local SurfaceLock = require("modules/surface_export/utils/surface-lock")

--- Lock a platform for transfer (prevents modifications)
--- @param platform_index number: Platform index
--- @param force_name string: Force name
--- @return boolean, string|nil: success, error_message
local function lock_platform_for_transfer(platform_index, force_name)
  force_name = force_name or "player"

  local force = game.forces[force_name]
  if not force then
    return false, "Force not found: " .. force_name
  end

  local platform = force.platforms[platform_index]
  if not platform then
    return false, "Platform not found at index: " .. platform_index
  end

  return SurfaceLock.lock_platform(platform, force)
end

return lock_platform_for_transfer
