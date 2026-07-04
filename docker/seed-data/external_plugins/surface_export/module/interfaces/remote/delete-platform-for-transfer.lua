-- Remote Interface: delete_platform_for_transfer
-- The source-side teardown of a SUCCESSFULLY transferred platform — the controller calls this (the SOLE
-- DeleteSourcePlatformRequest path) after the destination has committed the import. One atomic call so it all
-- happens in a single tick with no interleaving:
--   1. best-effort unlock (clears the lock-registry entry for this index),
--   2. resolve the platform by its UNIQUE INDEX and apply the IDENTITY GATE — key on the STABLE surface.index
--      (recorded in the lock at lock time), NOT the mutable platform.name; refuse if the lock was released or
--      the surface differs (rename-proof; SurfaceLock.transfer_delete_identity_ok, Pitfall #31),
--   3. EVACUATE anyone bodily aboard to a planet (never orphan a player when the surface vanishes —
--      Gateway.evacuate_passengers; native-aligned with how the engine handles hub loss),
--   4. delete the platform via GameUtils.delete_platform (game.delete_surface under the hood — NOT raw, so it
--      goes through the version-correct teardown seam; Pitfall #19 / memory delete-bypasses-gateway-teardown).
--
-- INDEX is the join key (Factorio's own `force.platforms` is keyed by the unique platform.index). Identity is
-- the STABLE surface.index — a player can RENAME a platform mid-transfer from the hub GUI, so the old name-based
-- cross-check both FALSE-REFUSED a renamed source (→ a duplicate) and could match the WRONG same-named platform.
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

  -- IDENTITY GATE — surface.index, NEVER the mutable platform.name (invariant: platform identity = surface.index
  -- / unique index). At lock time the transfer lock recorded the surface.index of the exact platform we exported.
  -- surface.index is the STABLE unique identity: it survives a player rename; platform.name does NOT. Reading it
  -- HERE, before the best-effort unlock (which clears the lock), gives a rename-proof check and closes the rename
  -- DUPLICATION exploit — a player who renamed the source mid-transfer used to make the old name-based check
  -- REFUSE the delete → source survived + dest committed = two live copies. This also gates on the source still
  -- being locked-for-transfer: if the source-side TTL (or an admin) already released the lock, the source is LIVE
  -- again and MUST NOT be deleted — refuse, leaving a recoverable duplicate rather than deleting a live platform.
  local lock = SurfaceLock.get_lock_data(platform_index)

  -- Best-effort unlock FIRST (recovery on EVERY path incl. a refused delete, so a refusal never leaves the
  -- source frozen-and-hidden). Only meaningful when a lock exists; unlock's own identity check is surface.index
  -- based, and the STORED name is passed only to satisfy its name tripwire self-consistently.
  if lock then
    GameUtils.pcall_warn("[DeleteForTransfer] unlock index " .. tostring(platform_index), function()
      SurfaceLock.unlock_platform(platform_index, lock.platform_name)
    end)
  end

  -- Resolve by the UNIQUE index, then CROSS-CHECK the STABLE surface.index. If the index is missing, or the
  -- platform there is a DIFFERENT surface than the one we locked (stale/reused index), REFUSE (the safe
  -- direction): the source survives (now unlocked, above), the dest copy is already committed, loud error.
  -- A rename is correctly IGNORED — same surface.index ⇒ same platform ⇒ proceed.
  local platform = force.platforms[platform_index]
  if not platform or not platform.valid then
    return "ERROR:Platform not found at index " .. tostring(platform_index)
  end
  local id_ok, id_reason = SurfaceLock.transfer_delete_identity_ok(lock, platform.surface)
  if not id_ok then
    return "ERROR:" .. tostring(id_reason) .. " — refusing to delete platforms[" .. tostring(platform_index) .. "]"
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
