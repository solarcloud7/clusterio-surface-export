-- Command: /export-platform
-- Export a platform to JSON (async)

local Base = require("modules/surface_export/interfaces/commands/base")
local AsyncProcessor = require("modules/surface_export/core/async-processor")

Base.admin_command("export-platform",
  "Export a platform to JSON (async). Usage: /export-platform [platform_index] [destination_instance_id]",
  function(cmd, ctx)
    -- Parse parameters: platform_index [destination_instance_id]
    local params = Base.parse_params(ctx.param)
    local platform_index = tonumber(params[1])
    local destination_instance_id = tonumber(params[2])
    
    -- Platform detection logic
    if not platform_index then
      if not ctx.player then
        ctx.print("Error: Platform index required when using RCON. Usage: /export-platform <platform_index> [destination_instance_id]")
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
        ctx.print("Usage: /export-platform <platform_index> [destination_instance_id]")
        ctx.print("Or stand on a platform and run /export-platform with no parameters")
        return
      end
    end
    
    if not ctx.force.platforms[platform_index] then
      ctx.print(string.format("Error: Platform index %d not found", platform_index))
      return
    end
    
    -- Queue async export with optional destination
    local force_name = ctx.force.name
    local job_id, queue_err = AsyncProcessor.queue_export(
      platform_index,
      force_name,
      ctx.player and ctx.player.name or "RCON",
      destination_instance_id
    )
    
    if job_id then
      local message
      if destination_instance_id then
        message = string.format("Export queued: %s (will transfer to instance %d)", job_id, destination_instance_id)
      else
        message = string.format("Export queued: %s (processing async)", job_id)
      end
      log(string.format("[INFO] %s", message))
      if ctx.player then
        game.print(message, {1, 1, 0})  -- Yellow
      else
        ctx.print("QUEUED:" .. job_id)
      end
    else
      ctx.print(queue_err or "Failed to queue export")
    end
  end
)
