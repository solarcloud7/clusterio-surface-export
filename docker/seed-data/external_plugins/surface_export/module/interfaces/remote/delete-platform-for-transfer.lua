local Gateway = require("modules/surface_export/core/gateway")
local GameUtils = require("modules/surface_export/utils/game-utils")
local SurfaceLock = require("modules/surface_export/utils/surface-lock")

local function delete_platform_for_transfer(platform_index, platform_name, force_name, expected_job_id)
  local force = game.forces[force_name]
  if not force then
    return "ERROR:Force not found: " .. tostring(force_name)
  end

  local lock = SurfaceLock.get_lock_data(platform_index)
  local platform = force.platforms[platform_index]
  local id_ok, id_reason = SurfaceLock.transfer_delete_identity_ok(lock, platform and platform.surface, expected_job_id)
  if not id_ok then
    return "ERROR:" .. tostring(id_reason) .. " — refusing to delete platforms[" .. tostring(platform_index) .. "]"
  end

  if SurfaceLock.source_lock_is_committed(lock) then
    local cleared, clear_err = SurfaceLock.clear_committed_source_lock_after_delete(platform_index, expected_job_id)
    if not cleared then
      return "ERROR:committed source lock clear failed: " .. tostring(clear_err)
    end
  else
    GameUtils.pcall_warn("[DeleteForTransfer] unlock index " .. tostring(platform_index), function()
      SurfaceLock.unlock_platform(platform_index)
    end)
  end
  GameUtils.pcall_warn("[DeleteForTransfer] evacuate '" .. tostring(platform_name) .. "'", function()
    Gateway.evacuate_passengers(platform)
  end)

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
