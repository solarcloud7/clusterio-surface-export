local AsyncProcessor = require("modules/surface_export/core/async-processor")

local function export_platform(platform_index, force_name, destination_instance_id)
  local job_id, err = AsyncProcessor.queue_export(platform_index, force_name, nil, destination_instance_id)
  if not job_id then
    log(string.format("[Export ERROR] Failed to queue export: %s", err or "unknown"))
    return nil, err
  end
  
  return job_id
end

return export_platform
