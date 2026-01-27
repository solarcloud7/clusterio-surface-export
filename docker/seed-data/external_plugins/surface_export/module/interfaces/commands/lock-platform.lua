-- Command: /lock-platform
-- Lock a platform for testing (completes cargo pods, freezes entities)

local Base = require("modules/surface_export/interfaces/commands/base")
local SurfaceLock = require("modules/surface_export/utils/surface-lock")

Base.admin_command("lock-platform", 
  "Lock a platform for testing - completes cargo pods and freezes entities (usage: /lock-platform [platform_name_or_index])",
  function(cmd, ctx)
    local param = ctx.param
    local target_platform = nil

    -- If no parameter, try to use player's current platform
    if not param or param == "" then
      if ctx.player then
        local surface = ctx.player.surface
        if surface and surface.platform then
          target_platform = surface.platform
          ctx.print("Using current platform: " .. target_platform.name)
        else
          ctx.print("You are not on a platform surface.")
          ctx.print("Usage: /lock-platform [platform_name_or_index]")
          ctx.print("Tip: Use /list-platforms to see available platforms")
          return
        end
      else
        ctx.print("Usage: /lock-platform <platform_name_or_index>")
        ctx.print("(RCON requires platform name/index)")
        return
      end
    end

    -- Find platform by name or index
    if not target_platform then
      target_platform = Base.find_platform(ctx.force, param)
    end

    if not target_platform then
      ctx.print("Error: Platform not found: " .. param)
      ctx.print("Tip: Use /list-platforms to see available platforms")
      return
    end

    -- Check if already locked
    if SurfaceLock.is_locked(target_platform.name) then
      ctx.print("Platform '" .. target_platform.name .. "' is already locked")
      ctx.print("Use /unlock-platform to unlock it first")
      return
    end

    -- Lock the platform
    local lock_success, lock_err = SurfaceLock.lock_platform(target_platform, ctx.force)
    
    if lock_success then
      ctx.print("Platform '" .. target_platform.name .. "' locked successfully")
      ctx.print("  - Cargo pods completed and items recovered")
      ctx.print("  - Entity freezing started (check /lock-status for progress)")
      ctx.print("Use /unlock-platform " .. target_platform.name .. " to unlock")
    else
      ctx.print("Error locking platform: " .. (lock_err or "unknown error"))
    end
  end
)
