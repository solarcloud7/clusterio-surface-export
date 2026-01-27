-- Remote Interface: export_platform
-- Export a platform and return the data (for Clusterio)

local Safety = require("modules/surface_export/core/safety")

--- Export a platform and return the data (for Clusterio)
--- @param platform_index number: The index of the platform to export (1-based)
--- @param force_name string: Force name
--- @return table|nil: Export data on success, nil on failure
local function export_platform(platform_index, force_name)
  local result, export_id = Safety.atomic_export(platform_index, force_name)
  if result and storage.platform_exports and storage.platform_exports[export_id] then
    return storage.platform_exports[export_id]
  end
  return nil
end

return export_platform
