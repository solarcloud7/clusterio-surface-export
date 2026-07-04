-- Remote Interface: delete_platform_for_transfer
-- The source-side teardown of a SUCCESSFULLY transferred platform — the controller calls this (the SOLE
-- DeleteSourcePlatformRequest path) after the destination has committed the import. One atomic call so it all
-- happens in a single tick with no interleaving:
--   1. IDENTITY GATE (before any destructive step): correlate the request to the lock by the NAME-FREE transfer
--      id (the request's exportId == the lock's transfer_job_id) AND match the lock's stored surface.index to the
--      live platform's surface.index (STABLE across a rename; platform.name is never consulted). Refuse otherwise
--      (SurfaceLock.transfer_delete_identity_ok, Pitfall #31 / re-audit P1),
--   2. best-effort unlock — only once the gate proved this is THIS transfer's platform (clears the lock entry),
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
--- @param platform_name string   -- display/logging only (NOT identity)
--- @param force_name string
--- @param expected_job_id string|nil  -- the transfer's exportId (== the lock's transfer_job_id); a NAME-FREE
---        request-vs-lock correlation so a stale/reused-index delete can't tear down an unrelated transfer
--- @return string "SUCCESS" or "ERROR:<reason>"
local function delete_platform_for_transfer(platform_index, platform_name, force_name, expected_job_id)
  local force = game.forces[force_name]
  if not force then
    return "ERROR:Force not found: " .. tostring(force_name)
  end

  -- IDENTITY GATE — runs BEFORE any destructive unlock/delete (re-audit P1). Two checks, both NAME-FREE:
  --   (1) request-vs-lock correlation — the request's exportId (== the lock's transfer_job_id) must match the
  --       lock at this index, so a stale/duplicate/reused-index delete for a DIFFERENT transfer is refused
  --       WITHOUT unlocking or restoring the unrelated transfer's platform (that clobber was the P1-b bug); and
  --   (2) lock-vs-live-platform — the current platform's surface.index must equal the lock's stored
  --       surface_index. surface.index is STABLE across a player rename (platform.name is never consulted), so
  --       a rename is correctly IGNORED and the rename DUPLICATION exploit stays closed.
  -- A released lock (TTL/admin) or a reused index is refused, leaving a recoverable state rather than deleting a
  -- live/unrelated platform. Decision is the pure, unit-tested SurfaceLock.transfer_delete_identity_ok.
  local lock = SurfaceLock.get_lock_data(platform_index)
  local platform = force.platforms[platform_index]
  local id_ok, id_reason = SurfaceLock.transfer_delete_identity_ok(lock, platform and platform.surface, expected_job_id)
  if not id_ok then
    return "ERROR:" .. tostring(id_reason) .. " — refusing to delete platforms[" .. tostring(platform_index) .. "]"
  end

  -- Validated: THIS transfer's lock AND our live platform. Best-effort unlock (unfreezes, un-hides, restores the
  -- original schedule, clears the lock entry), then evacuate + delete — safe now because the gate proved it's ours.
  GameUtils.pcall_warn("[DeleteForTransfer] unlock index " .. tostring(platform_index), function()
    SurfaceLock.unlock_platform(platform_index, lock.platform_name)
  end)

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
