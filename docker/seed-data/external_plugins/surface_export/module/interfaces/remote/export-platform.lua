-- Remote Interface: export_platform
-- Queue async export and return job ID (for Clusterio)

local AsyncProcessor = require("modules/surface_export/core/async-processor")

--- Queue async platform export and return job ID
--- @param platform_index number: The index of the platform to export (1-based)
--- @param force_name string: Force name
--- @param destination_instance_id number|nil: Optional transfer destination instance ID
--- @return string|nil, string|nil: Job ID (export_id) on success, nil and error on failure
local function export_platform(platform_index, force_name, destination_instance_id)
  local job_id, err = AsyncProcessor.queue_export(platform_index, force_name, nil, destination_instance_id)
  if not job_id then
    log(string.format("[Export ERROR] Failed to queue export: %s", err or "unknown"))
    return nil, err
  end
  
  -- Return job ID - caller retrieves data from storage.platform_exports[job_id] after completion
  return job_id
end

return export_platform
