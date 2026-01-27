-- Command: /list-exports
-- List available platform exports (from async exports)

local Base = require("modules/surface_export/interfaces/commands/base")

Base.admin_command("list-exports", "List available platform exports (from async exports)", function(cmd, ctx)
  -- List exports from memory (async export system)
  if not storage.platform_exports then
    ctx.print("No exports found. Use /export-platform <index> to export a platform")
    return
  end
  
  local count = 0
  local exports_list = {}
  for export_id, export_data in pairs(storage.platform_exports) do
    count = count + 1
    table.insert(exports_list, {
      id = export_id,
      platform_name = export_data.platform_name or "Unknown",
      entity_count = export_data.stats and export_data.stats.entity_count or 0,
      timestamp = export_data.timestamp or "Unknown"
    })
  end
  
  if count == 0 then
    ctx.print("No exports found. Use /export-platform <index> to export a platform")
    return
  end
  
  -- Sort by timestamp
  table.sort(exports_list, function(a, b) return (a.timestamp or "") > (b.timestamp or "") end)
  
  ctx.print(string.format("Found %d export(s) in memory:", count))
  for i, entry in ipairs(exports_list) do
    ctx.print(string.format("  [%d] %s (%d entities, %s)", i, entry.id, entry.entity_count, entry.timestamp))
  end
  ctx.print("Use /import-platform <export_id> to import on another instance")
end)
