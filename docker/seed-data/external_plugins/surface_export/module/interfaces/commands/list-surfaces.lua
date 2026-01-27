-- Command: /list-surfaces
-- List all surfaces with their indices

local Base = require("modules/surface_export/interfaces/commands/base")

Base.admin_command("list-surfaces", "List all surfaces with their indices (needed for import-platform)", function(cmd, ctx)
  local surfaces = {}
  for _, surface in pairs(game.surfaces) do
    table.insert(surfaces, {
      index = surface.index,
      name = surface.name,
      platform = surface.platform
    })
  end
  
  -- Sort by index
  table.sort(surfaces, function(a, b) return a.index < b.index end)
  
  if #surfaces == 0 then
    ctx.print("No surfaces found")
    return
  end
  
  ctx.print(string.format("Found %d surface(s):", #surfaces))
  for _, surf in ipairs(surfaces) do
    local type_info = surf.platform and "(Space Platform)" or "(Planet/Special)"
    ctx.print(string.format("  Surface %d: %s %s", surf.index, surf.name, type_info))
  end
  ctx.print("Note: import-platform automatically creates new platforms")
end)
