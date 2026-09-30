local SurfaceLock = require("modules/surface_export/utils/surface-lock")
local SourceBeltCargo = require("modules/surface_export/core/source-belt-cargo")

local function belt_cargo_override(platform_index, action)
  local index = tonumber(platform_index)
  if not index then return { success = false, error = "Platform index is required" } end
  local lock = SurfaceLock.get_lock_data(index)
  if not lock then return { success = false, error = "Platform is not locked" } end
  if action == "describe" then
    return { success = true, message = SourceBeltCargo.describe(lock.cleared_belts), recorded = lock.cleared_belts ~= nil }
  end
  local force = game.forces[lock.force_name]
  local platform = force and force.platforms[lock.platform_index]
  local surface = platform and platform.valid and platform.surface or nil
  local ok, detail = SourceBeltCargo.override(lock, action, lock.platform_name, surface)
  if not ok then return { success = false, error = tostring(detail) } end
  return { success = true, message = tostring(detail), recorded = lock.cleared_belts ~= nil }
end

return belt_cargo_override
