-- Command: /delete-surfaces
-- Delete multiple surfaces by name pattern (for test cleanup)

local Base = require("modules/surface_export/interfaces/commands/base")

Base.admin_command("delete-surfaces", "Delete surfaces matching a name pattern (use with caution!)", function(cmd, ctx)
  local pattern = cmd.parameter
  if not pattern or pattern == "" then
    ctx.print("Usage: /delete-surfaces <name-pattern>")
    ctx.print("Example: /delete-surfaces entity-test-")
    ctx.print("This will delete all surfaces whose names contain the pattern.")
    return
  end
  
  -- Find matching surfaces (only space platform surfaces can be safely deleted)
  local to_delete = {}
  for _, surface in pairs(game.surfaces) do
    if surface.platform and string.find(surface.name, pattern, 1, true) then
      table.insert(to_delete, {
        name = surface.name,
        platform = surface.platform
      })
    end
  end
  
  if #to_delete == 0 then
    ctx.print(string.format("No platform surfaces found matching '%s'", pattern))
    return
  end
  
  ctx.print(string.format("Deleting %d surface(s) matching '%s':", #to_delete, pattern))
  
  local deleted = 0
  local failed = 0
  
  for _, surf in ipairs(to_delete) do
    local platform = surf.platform
    if platform and platform.valid then
      -- Schedule for immediate deletion (will happen at end of current tick)
      platform.destroy(0)
      ctx.print(string.format("  Scheduled: %s", surf.name))
      deleted = deleted + 1
    else
      ctx.print(string.format("  Failed (invalid platform): %s", surf.name))
      failed = failed + 1
    end
  end
  
  ctx.print(string.format("Scheduled %d for deletion, %d failed", deleted, failed))
  ctx.print("Note: Deletion completes after game tick advances")
end)
