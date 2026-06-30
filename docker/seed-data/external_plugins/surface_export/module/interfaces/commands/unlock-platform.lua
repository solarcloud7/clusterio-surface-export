-- Command: /unlock-platform
-- Unlock a locked platform (restores entities and visibility)

local Base = require("modules/surface_export/interfaces/commands/base")
local SurfaceLock = require("modules/surface_export/utils/surface-lock")

Base.admin_command("unlock-platform",
  "Unlock a locked platform - restores entities and visibility (usage: /unlock-platform [platform_name_or_index])",
  function(cmd, ctx)
    local param = ctx.param
    local platform_name = param
    local lock_key = nil

    -- If no parameter, try to use player's current platform
    if not param or param == "" then
      if ctx.player then
        local surface = ctx.player.surface
        if surface and surface.platform then
          platform_name = surface.platform.name
          lock_key = surface.platform.index
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
    else
      -- Resolve the name-or-index to the lock-registry key (unique index), failing loud on an ambiguous name.
      -- Prefer the live platform's display name for messages; fall back to the stored lock name (orphaned lock).
      local err, display_name
      lock_key, err, display_name = Base.resolve_lock_key(ctx.force, param)
      if err then ctx.print(err); return end
      if display_name then platform_name = display_name end
      local lock_data = lock_key and SurfaceLock.get_lock_data(lock_key)
      if lock_data and lock_data.platform_name then platform_name = lock_data.platform_name end
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
