local Base = require("modules/surface_export/interfaces/commands/base")
local SurfaceLock = require("modules/surface_export/utils/surface-lock")

Base.admin_command("lock-status",
  "Show status of all locked platforms (usage: /lock-status [platform_name])",
  function(cmd, ctx)
    local param = ctx.param
    
    if (not param or param == "") and ctx.player then
      local surface = ctx.player.surface
      if surface and surface.platform then
        param = surface.platform.name
        ctx.print("Checking current platform: " .. param)
      end
    end
    
    if not storage.locked_platforms or next(storage.locked_platforms) == nil then
      ctx.print("No platforms are currently locked")
      ctx.print("Use /lock-platform <name> to lock a platform")
      return
    end
    
    if param and param ~= "" then
      local lock_key, err = Base.resolve_lock_key(ctx.force, param)
      if err then ctx.print(err); return end
      local lock_data = lock_key and SurfaceLock.get_lock_data(lock_key)
      if not lock_data then
        ctx.print("Platform '" .. param .. "' is not locked")
        return
      end
      
      local age_ticks = game.tick - lock_data.locked_tick
      local age_seconds = math.floor(age_ticks / 60)
      
      ctx.print("Lock status for platform '" .. param .. "':")
      ctx.print("  Platform index: " .. lock_data.platform_index)
      ctx.print("  Surface index: " .. lock_data.surface_index)
      ctx.print("  Force: " .. lock_data.force_name)
      ctx.print("  Locked for: " .. age_seconds .. " seconds (" .. age_ticks .. " ticks)")
      ctx.print("  Entities frozen: " .. (lock_data.frozen_count or 0))
      ctx.print("  Originally hidden: " .. tostring(lock_data.original_hidden))
      return
    end
    
    ctx.print("Locked platforms:")
    local count = 0
    for platform_index, lock_data in pairs(storage.locked_platforms) do
      count = count + 1
      local age_ticks = game.tick - lock_data.locked_tick
      local age_seconds = math.floor(age_ticks / 60)

      ctx.print(string.format("  %d. %s (index %s, locked %ds ago, %d entities frozen)",
        count, tostring(lock_data.platform_name), tostring(platform_index), age_seconds, lock_data.frozen_count or 0))
    end
    
    ctx.print("")
    ctx.print("Use /lock-status <platform_name> for details")
    ctx.print("Use /unlock-platform <name> to unlock")
  end
)
