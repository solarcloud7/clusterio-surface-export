local SurfaceLock = require("modules/surface_export/utils/surface-lock")

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

  return SurfaceLock.lock_platform(platform, force, {
    kind = "transfer",
    expires_tick = game.tick + SurfaceLock.DEFAULT_TRANSFER_LOCK_TTL_TICKS,
  })
end

return lock_platform_for_transfer
