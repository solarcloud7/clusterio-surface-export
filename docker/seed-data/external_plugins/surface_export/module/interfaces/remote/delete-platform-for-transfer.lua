-- Remote Interface: delete_platform_for_transfer
-- The source-side teardown of a SUCCESSFULLY transferred platform — the controller calls this (the SOLE
-- DeleteSourcePlatformRequest path) after the destination has committed the import. One atomic call so it all
-- happens in a single tick with no interleaving:
--   1. resolve the platform by its UNIQUE INDEX and CROSS-CHECK the name (refuse on mismatch — see below),
--   2. best-effort unlock (clears the lock-registry entry for this index),
--   3. EVACUATE anyone bodily aboard to a planet (never orphan a player when the surface vanishes —
--      Gateway.evacuate_passengers; native-aligned with how the engine handles hub loss),
--   4. delete the platform via GameUtils.delete_platform (game.delete_surface under the hood — NOT raw, so it
--      goes through the version-correct teardown seam; Pitfall #19 / memory delete-bypasses-gateway-teardown).
--
-- INDEX is the join key (Factorio's own `force.platforms` is keyed by the unique platform.index); NAME is a
-- mutable, non-unique label used only as a tripwire. Resolving a destructive delete by name (the old code)
-- is "DELETE WHERE name=?" on a non-unique column — a silent first-match could tear down the WRONG platform.
--
-- Returns the RAW "SUCCESS" / "ERROR:<reason>" contract the instance plugin already parses.

local Gateway = require("modules/surface_export/core/gateway")
local GameUtils = require("modules/surface_export/utils/game-utils")
local SurfaceLock = require("modules/surface_export/utils/surface-lock")

--- @param platform_index number  -- the unique platform index (join key)
--- @param platform_name string   -- the expected display name (cross-check tripwire)
--- @param force_name string
--- @return string "SUCCESS" or "ERROR:<reason>"
local function delete_platform_for_transfer(platform_index, platform_name, force_name)
  local force = game.forces[force_name]
  if not force then
    return "ERROR:Force not found: " .. tostring(force_name)
  end

  -- Best-effort unlock FIRST, by index. This runs on EVERY path below — INCLUDING a refused delete — so a
  -- refusal never leaves the source frozen-and-hidden (it would otherwise vanish from the owner's list until
  -- an admin manually unlocked it, while the dest copy is already a live duplicate). unlock_platform is
  -- identity-safe: it restores a renamed source but drops a stale/reused-index lock without clobbering. On the
  -- success path the platform is deleted immediately after, so the brief restore is harmless.
  GameUtils.pcall_warn("[DeleteForTransfer] unlock index " .. tostring(platform_index), function()
    SurfaceLock.unlock_platform(platform_index)
  end)

  -- Resolve by the UNIQUE index, then CROSS-CHECK the name. If the index is missing OR the platform there is
  -- not the one we exported (stale/reused index, or a renamed/mismatched platform), REFUSE to delete (the
  -- safe direction): the source survives (now unlocked, above), the dest copy is already committed, loud error.
  local platform = force.platforms[platform_index]
  if not platform or not platform.valid then
    return "ERROR:Platform not found at index " .. tostring(platform_index)
  end
  if platform.name ~= platform_name then
    return string.format("ERROR:index/name mismatch — platforms[%s] is '%s', expected '%s' (refusing to delete)",
      tostring(platform_index), tostring(platform.name), tostring(platform_name))
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
    game.print(string.format("[Transfer Complete] Platform '%s' (index %s) transferred and deleted from source",
      platform_name, tostring(platform_index)), {0, 1, 0})
    return "SUCCESS"
  end
  return "ERROR:delete_platform could not remove '" .. tostring(platform_name) .. "' (no valid surface)"
end

return delete_platform_for_transfer
