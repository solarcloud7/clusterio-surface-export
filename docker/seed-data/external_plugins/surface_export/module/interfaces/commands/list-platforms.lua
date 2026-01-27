-- Command: /list-platforms
-- List all available space platforms

local Base = require("modules/surface_export/interfaces/commands/base")

Base.admin_command("list-platforms", "List all available space platforms", function(cmd, ctx)
  local platforms = ctx.force.platforms
  
  -- Count platforms
  local count = 0
  for _ in pairs(platforms) do
    count = count + 1
  end
  
  if count == 0 then
    ctx.print("No platforms found")
    return
  end

  ctx.print(string.format("Found %d platform(s):", count))
  for index, platform in pairs(platforms) do
    local entity_count = 0
    if platform.surface and platform.surface.valid then
      local entities = platform.surface.find_entities_filtered({})
      entity_count = #entities
    end
    ctx.print(string.format("  [%d] %s (Force: %s, Entities: %d)",
      index,
      platform.name,
      platform.force.name,
      entity_count
    ))
  end
end)
