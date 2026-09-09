local Timing = require("modules/surface_export/utils/operation-timing")
local Gateway = require("modules/surface_export/core/gateway")
local GameUtils = require("modules/surface_export/utils/game-utils")
local SurfaceLock = require("modules/surface_export/utils/surface-lock")
local Receipts = require("modules/surface_export/utils/transfer-receipts")

local function delete_platform_for_transfer(platform_index, platform_name, force_name, expected_job_id)
  if type(expected_job_id) ~= "string" or expected_job_id == "" then
    return "ERROR:missing source job identity"
  end
  local force = game.forces[force_name]
  if not force then
    return "ERROR:Force not found: " .. tostring(force_name)
  end

  local lock = SurfaceLock.get_lock_data(platform_index)
  local platform = force.platforms[platform_index]
  local receipt = expected_job_id and Receipts.get("source_deleted", expected_job_id)
  if receipt then
    if receipt.platform_index == platform_index and receipt.force_name == force_name
        and not (platform and platform.valid) then return "SUCCESS" end
    return "ERROR:source deletion receipt identity mismatch"
  end
  local id_ok, id_reason = SurfaceLock.transfer_delete_identity_ok(lock, platform and platform.surface, expected_job_id)
  if not id_ok then
    return "ERROR:" .. tostring(id_reason) .. " — refusing to delete platforms[" .. tostring(platform_index) .. "]"
  end

  -- Retain identity and the frozen source until deletion actually succeeds.
  -- A failed request must not unlock it or publish a source-deleted tombstone.
  GameUtils.pcall_warn("[DeleteForTransfer] evacuate '" .. tostring(platform_name) .. "'", function()
    Gateway.evacuate_passengers(platform)
  end)

  local ok, deleted = pcall(function() return GameUtils.delete_platform(platform) end)
  if not ok then
    return "ERROR:delete_platform failed: " .. tostring(deleted)
  end
  if deleted then
    if SurfaceLock.source_lock_is_committed(lock) then
      local cleared, clear_err = SurfaceLock.clear_committed_source_lock_after_delete(platform_index, expected_job_id)
      if not cleared then
        return "ERROR:committed source lock clear failed: " .. tostring(clear_err)
      end
    else
      storage.locked_platforms[platform_index] = nil
    end
    if expected_job_id then
      Receipts.put("source_deleted", expected_job_id, {
        platform_index = platform_index, force_name = force_name,
        surface_index = lock.surface_index, tick = game.tick,
      })
    end
    game.print(string.format("[Transfer Complete] Platform '%s' (index %s) transferred and deleted from source",
      platform_name, tostring(platform_index)), {0, 1, 0})
    return "SUCCESS"
  end
  return "ERROR:delete_platform could not remove '" .. tostring(platform_name) .. "' (no valid surface)"
end

return function(platform_index, platform_name, force_name, expected_job_id)
  storage.surface_export_timing_sequence = (storage.surface_export_timing_sequence or 0) + 1
 local id = "recovery_" .. storage.surface_export_timing_sequence
 Timing.begin(id, "recovery-lua", nil, expected_job_id)
 local result = table.pack(Timing.scope(id, "source_deletion", delete_platform_for_transfer, platform_index, platform_name, force_name, expected_job_id))
 local failed = result[1] == false or (type(result[1]) == "string" and result[1]:sub(1, 6) == "ERROR:")
 Timing.finish(id, failed and "failed" or "completed")
 return table.unpack(result, 1, result.n)
end
