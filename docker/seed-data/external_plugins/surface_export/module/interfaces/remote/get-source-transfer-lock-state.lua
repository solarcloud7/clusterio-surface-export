local SurfaceLock = require("modules/surface_export/utils/surface-lock")

local function get_source_transfer_lock_state(transfer_id, platform_index, platform_name, force_name)
  local idx = tonumber(platform_index)
  if not idx then
    return { state = "identity_mismatch", transferId = transfer_id, error = "invalid platform index" }
  end
  return SurfaceLock.get_source_transfer_lock_state(
    transfer_id,
    idx,
    platform_name,
    force_name or "player"
  )
end

return get_source_transfer_lock_state