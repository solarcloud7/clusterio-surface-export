-- Remote Interface: export_platform_to_file
-- Export platform to disk file (script-output directory)

local Safety = require("modules/surface_export/core/safety")
local Util = require("modules/surface_export/utils/util")

--- Export platform to disk file (script-output directory)
--- @param platform_index number: The index of the platform to export (1-based)
--- @param force_name string: Force name
--- @param filename string (optional): Custom filename (defaults to platform_name_tick.json)
--- @return boolean, string: Success flag and filename/error message
local function export_platform_to_file(platform_index, force_name, filename)
  local result, export_id = Safety.atomic_export(platform_index, force_name)
  if not result then
    return false, export_id  -- export_id contains error message on failure
  end
  
  -- Get the export data
  if not storage.platform_exports or not storage.platform_exports[export_id] then
    return false, "Export data not found in storage"
  end
  
  local export_entry = storage.platform_exports[export_id]
  local json_string = export_entry.json_string
  
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
