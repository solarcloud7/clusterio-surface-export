-- Command: /lock-status
-- Show status of locked platforms

local Base = require("modules/surface_export/interfaces/commands/base")
local SurfaceLock = require("modules/surface_export/utils/surface-lock")

Base.admin_command("lock-status",
  "Show status of all locked platforms (usage: /lock-status [platform_name])",
  function(cmd, ctx)
    local param = ctx.param
    
    -- If no parameter and player is on a platform, show that platform's status
    if (not param or param == "") and ctx.player then
      local surface = ctx.player.surface
      if surface and surface.platform then
        param = surface.platform.name
        ctx.print("Checking current platform: " .. param)
      end
    end
    
    -- Check if any locks exist
    if not storage.locked_platforms or next(storage.locked_platforms) == nil then
      ctx.print("No platforms are currently locked")
      ctx.print("Use /lock-platform <name> to lock a platform")
      return
    end
    
    -- If specific platform requested
    if param and param ~= "" then
      -- Resolve the user input (name or index) to the unique platform index (the registry key); for an
      -- orphaned lock (platform deleted) fall back to a name scan of the registry (fail-loud on ambiguity).
      local target = Base.find_platform(ctx.force, param)
      local lock_key = target and target.index
      if not lock_key then
        local key, ambiguous_err = SurfaceLock.find_lock_key_by_name(param)
        if ambiguous_err then ctx.print(ambiguous_err); return end
        lock_key = key
      end
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
    
    -- List all locked platforms
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
