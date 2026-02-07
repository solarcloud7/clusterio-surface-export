-- Remote Interface: export_platform_to_file
-- Queue async export and write to file when complete

local AsyncProcessor = require("modules/surface_export/core/async-processor")
local Util = require("modules/surface_export/utils/util")

--- Export platform to disk file (script-output directory)
--- @param platform_index number: The index of the platform to export (1-based)
--- @param force_name string: Force name
--- @param filename string (optional): Custom filename (defaults to platform_name_tick.json)
--- @return boolean, string: Success flag and job_id/error message
local function export_platform_to_file(platform_index, force_name, filename)
  local job_id, err = AsyncProcessor.queue_export(platform_index, force_name, nil, nil)
  if not job_id then
    return false, err or "Failed to queue export"
  end
  
  -- Store file write request for when export completes
  storage.pending_file_writes = storage.pending_file_writes or {}
  storage.pending_file_writes[job_id] = {
    filename = filename,
    requested_tick = game.tick
  }
  
  -- For now, return job_id as "filename" - actual file write happens async
  local export_entry = storage.platform_exports and storage.platform_exports[job_id]
  local json_string = export_entry and export_entry.json_string
  
  -- Generate filename if not provided
  if not filename then
    filename = string.format("platform_exports/%s.json", export_id)
  end
  
  -- Write to file
  local success, write_error = Util.write_file_compat(filename, json_string, false)
  if not success then
    return false, string.format("Failed to write file: %s", write_error or "Unknown error")
  end
  
  log(string.format("[FactorioSurfaceExport] Exported platform to file: %s (%d KB)", filename, export_entry.stats.size_kb))
  return true, filename
end

return export_platform_to_file
