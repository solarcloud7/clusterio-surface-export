-- Remote Interface: delete_platform_for_transfer
-- The source-side teardown of a SUCCESSFULLY transferred platform — the controller calls this (the SOLE
-- DeleteSourcePlatformRequest path) after the destination has committed the import. One atomic call so it all
-- happens in a single tick with no interleaving:
--   1. best-effort unlock (clears the lock state for this name),
--   2. EVACUATE anyone bodily aboard to a planet (never orphan a player when the surface vanishes —
--      Gateway.evacuate_passengers; native-aligned with how the engine handles hub loss),
--   3. delete the platform via GameUtils.delete_platform (game.delete_surface under the hood — NOT raw, so it
--      goes through the version-correct teardown seam; Pitfall #19 / memory delete-bypasses-gateway-teardown).
--
-- Returns the RAW "SUCCESS" / "ERROR:<reason>" contract the instance plugin already parses.

local Gateway = require("modules/surface_export/core/gateway")
local GameUtils = require("modules/surface_export/utils/game-utils")
local SurfaceLock = require("modules/surface_export/utils/surface-lock")

--- @param platform_name string
--- @param force_name string
--- @return string "SUCCESS" or "ERROR:<reason>"
local function delete_platform_for_transfer(platform_name, force_name)
  -- Best-effort unlock so the lock-state entry for this name doesn't linger after deletion.
  GameUtils.pcall_warn("[DeleteForTransfer] unlock '" .. tostring(platform_name) .. "'", function()
    SurfaceLock.unlock_platform(platform_name)
  end)

  local force = game.forces[force_name]
  if not force then
    return "ERROR:Force not found: " .. tostring(force_name)
  end

  local platform = nil
  for _, p in pairs(force.platforms) do
    if p.valid and p.name == platform_name then
      platform = p
      break
    end
  end
  if not platform then
    return "ERROR:Platform not found: " .. tostring(platform_name)
  end

  -- Evacuate BEFORE deleting — players/characters must be off the surface before it is torn down. GUARDED
  -- (symmetric with the unlock above): an evacuation throw must NEVER abort the delete. If it did, the source
  -- would survive while the destination copy is already committed = a DUPLICATED platform (two-phase-commit
  -- violation, Pitfalls #28/#29). Orphan-avoidance is best-effort; never deleting the source is the worse sin.
  GameUtils.pcall_warn("[DeleteForTransfer] evacuate '" .. tostring(platform_name) .. "'", function()
    Gateway.evacuate_passengers(platform)
  end)

  -- Version-correct teardown (game.delete_surface under the hood; raw platform.destroy() is a no-op at 2.0.76).
  -- GUARDED so a delete throw returns the "ERROR:<reason>" contract the instance plugin parses, not a raw Lua
  -- error that escapes remote.call and leaves the caller with no usable result.
  local ok, deleted = pcall(function() return GameUtils.delete_platform(platform) end)
  if not ok then
    return "ERROR:delete_platform failed: " .. tostring(deleted)
  end
  if deleted then
    game.print(string.format("[Transfer Complete] Platform '%s' transferred and deleted from source", platform_name), {0, 1, 0})
    return "SUCCESS"
  end
  return "ERROR:delete_platform could not remove '" .. tostring(platform_name) .. "' (no valid surface)"
end

return delete_platform_for_transfer
