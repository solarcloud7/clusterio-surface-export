-- Remote Interface: get_export
-- Get an export by ID

--- Get an export by ID
--- @param export_id string: The export ID (platform_name_tick)
--- @return table|nil: Export data (may be compressed) or nil if not found
local function get_export(export_id)
  if storage.platform_exports then
    local export_data = storage.platform_exports[export_id]
    if export_data then
      -- Return compressed data as-is (plugin will handle decompression)
      -- Data structure: { compressed: bool, compression: string, payload: string, platform_name, tick, timestamp, stats }
      return export_data
    end
  end
  return nil
end

return get_export
