-- Remote Interface: list_exports
-- List all available exports

--- List all available exports
--- @return table: Array of export metadata
local function list_exports()
  local exports = {}
  if storage.platform_exports then
    for export_id, export_data in pairs(storage.platform_exports) do
      table.insert(exports, {
        id = export_id,
        platform_name = export_data.platform_name,
        tick = export_data.tick,
        timestamp = export_data.timestamp,
        stats = export_data.stats
      })
    end
  end
  return exports
end

return list_exports
