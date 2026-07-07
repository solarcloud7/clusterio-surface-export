-- Command: /resume-platform
-- Resume a platform after failed validation or manual inspection

local Base = require("modules/surface_export/interfaces/commands/base")
local AsyncProcessor = require("modules/surface_export/core/async-processor")
local SurfaceLock = require("modules/surface_export/utils/surface-lock")

Base.admin_command("resume-platform",
  "Resume a platform after failed validation (usage: /resume-platform <platform_name_or_index>)",
  function(cmd, ctx)
    local param = ctx.param
    if not param or param == "" then
      ctx.print("Usage: /resume-platform <platform_name_or_index>")
      ctx.print("Example: /resume-platform test")
      ctx.print("Example: /resume-platform 1")
      ctx.print("Tip: Use /list-platforms to see available platforms")
      return
    end

    local target_platform = Base.find_platform(ctx.force, param)

    if not target_platform then
      ctx.print(string.format("Platform '%s' not found", param))
      ctx.print("Use /list-platforms to see available platforms")
      return
    end

    local lock_data = SurfaceLock.get_lock_data(target_platform.index)
    if SurfaceLock.source_lock_is_committed(lock_data) then
      ctx.print(string.format("Platform '%s' has a committed transfer lock and cannot be resumed; only transfer delete may clear it", target_platform.name))
      return
    end
    local hold_active, hold_transfer_id = SurfaceLock.destination_hold_owns_surface(target_platform.surface, target_platform)
    if hold_active then
      ctx.print(string.format("Platform '%s' is owned by destination hold %s and cannot be resumed", target_platform.name, tostring(hold_transfer_id)))
      return
    end
    -- Unpause the platform (space travel)
    target_platform.paused = false
    ctx.print(string.format("✓ Platform '%s' space travel RESUMED", target_platform.name))

    -- Activate entities on the platform surface
    local surface = target_platform.surface
    if surface and surface.valid then
      local activated = AsyncProcessor.activate_platform(surface)
      ctx.print(string.format("✓ Activated %d entities on platform", activated))
    end

    game.print(string.format("[Platform] %s resumed and entities activated", target_platform.name), {0, 1, 0})
  end
)
