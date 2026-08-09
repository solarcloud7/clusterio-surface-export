local function get_export(export_id)
  if storage.platform_exports then
    local export_data = storage.platform_exports[export_id]
    if export_data then
      return export_data
    end
  end
  return nil
end

return get_export
