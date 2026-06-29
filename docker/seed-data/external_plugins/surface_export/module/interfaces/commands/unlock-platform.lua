-- Command: /unlock-platform
-- Unlock a locked platform (restores entities and visibility)

local Base = require("modules/surface_export/interfaces/commands/base")
local SurfaceLock = require("modules/surface_export/utils/surface-lock")

Base.admin_command("unlock-platform",
  "Unlock a locked platform - restores entities and visibility (usage: /unlock-platform [platform_name_or_index])",
  function(cmd, ctx)
    local param = ctx.param
    local target_platform = nil
    local platform_name = param

    -- If no parameter, try to use player's current platform
    if not param or param == "" then
      if ctx.player then
        local surface = ctx.player.surface
        if surface and surface.platform then
          target_platform = surface.platform
          platform_name = target_platform.name
          ctx.print("Using current platform: " .. platform_name)
        else
          ctx.print("You are not on a platform surface.")
          ctx.print("Usage: /unlock-platform [platform_name_or_index]")
          ctx.print("Tip: Use /lock-status to see locked platforms")
          return
        end
      else
        ctx.print("Usage: /unlock-platform <platform_name_or_index>")
        ctx.print("(RCON requires platform name/index)")
        return
      end
    end

    -- Find platform by name or index
    if not target_platform then
      target_platform = Base.find_platform(ctx.force, param)
      if target_platform then
        platform_name = target_platform.name
      end
    end

    -- Resolve the registry key (the unique platform index). A live platform → its index; an orphaned lock
    -- (platform already deleted) → recover by the stored display name (fail-loud on ambiguity).
    local lock_key = target_platform and target_platform.index
    if not lock_key then
      local key, ambiguous_err = SurfaceLock.find_lock_key_by_name(platform_name)
      if ambiguous_err then ctx.print(ambiguous_err); return end
      lock_key = key
    end

    -- Check if locked (can unlock even if the platform no longer exists)
    if not lock_key or not SurfaceLock.is_locked(lock_key) then
      ctx.print("Platform '" .. platform_name .. "' is not locked")
      ctx.print("Use /lock-status to see locked platforms")
      return
    end

    -- Unlock the platform
    local unlock_success, unlock_err = SurfaceLock.unlock_platform(lock_key)
    
    if unlock_success then
      ctx.print("Platform '" .. platform_name .. "' unlocked successfully")
      ctx.print("  - Entities restored to original active state")
      ctx.print("  - Surface visibility restored")
    else
      ctx.print("Error unlocking platform: " .. (unlock_err or "unknown error"))
    end
  end
)
