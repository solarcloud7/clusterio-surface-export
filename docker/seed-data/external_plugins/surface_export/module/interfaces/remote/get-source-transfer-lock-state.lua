local SurfaceLock = require("modules/surface_export/utils/surface-lock")

--- Return the authoritative source-side lock state for Phase-2 reconciliation.
--- Offline is a controller/transport state; this in-save query reports only states it can prove.
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