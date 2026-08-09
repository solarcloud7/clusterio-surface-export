local AsyncProcessor = require("modules/surface_export/core/async-processor")
local function export_platform_to_file(platform_index, force_name, filename)
  local job_id, err = AsyncProcessor.queue_export(platform_index, force_name, nil, nil)
  if not job_id then
    return false, err or "Failed to queue export"
  end
  
  storage.pending_file_writes = storage.pending_file_writes or {}
  storage.pending_file_writes[job_id] = {
    filename = filename,
    requested_tick = game.tick
  }
  
  return true, job_id
end

return export_platform_to_file
