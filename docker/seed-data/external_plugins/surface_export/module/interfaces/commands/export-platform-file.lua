-- Command: /export-platform-file
-- Export a platform to JSON file on disk

local Base = require("modules/surface_export/interfaces/commands/base")

Base.admin_command("export-platform-file",
  "Export a platform to JSON file on disk. Usage: /export-platform-file [platform_index]",
  function(cmd, ctx)
    local platform_index = tonumber(ctx.param)
    
    -- If no parameter provided, try to detect player's current platform
    if not platform_index then
      if not ctx.player then
        ctx.print("Error: Platform index required when using RCON. Usage: /export-platform-file <platform_index>")
        return
      end
      
      local player_surface = ctx.player.surface
      if player_surface and player_surface.platform then
        local platforms = ctx.force.platforms
        for index, platform in pairs(platforms) do
          if platform.surface == player_surface then
            platform_index = index
            ctx.print(string.format("Auto-detected platform: %s (index %d)", platform.name, index))
            break
          end
        end
        
        if not platform_index then
          ctx.print("Error: Could not find platform index for your current platform")
          return
        end
      else
        ctx.print("Usage: /export-platform-file <platform_index>")
        ctx.print("Or stand on a platform and run /export-platform-file with no parameters")
        ctx.print("Example: /export-platform-file 1")
        return
      end
    end
    
    ctx.print(string.format("Exporting platform %d to file...", platform_index))
    
    -- Call the remote interface function (now async - returns job_id)
    local result, job_id_or_error = remote.call("FactorioSurfaceExport", "export_platform_to_file", platform_index, ctx.force.name)

    if result then
      ctx.print(string.format("Export queued: %s", job_id_or_error))
      ctx.print("File will be written when export completes (check logs)")
    else
      ctx.print(string.format("Export failed: %s", job_id_or_error or "Unknown error"))
    end
  end
)
