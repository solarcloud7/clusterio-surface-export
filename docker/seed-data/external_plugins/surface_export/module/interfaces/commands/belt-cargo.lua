local Base = require("modules/surface_export/interfaces/commands/base")
local SurfaceLock = require("modules/surface_export/utils/surface-lock")
local SourceBeltCargo = require("modules/surface_export/core/source-belt-cargo")

Base.admin_command("belt-cargo",
  "Inspect or resolve belt cargo a transfer cleared from a locked platform (usage: /belt-cargo <platform_name_or_index> [describe|abandon|restore-present])",
  function(cmd, ctx)
    local target, action = SourceBeltCargo.parse_command(ctx.param, function(name)
      local key, lookup_err = Base.resolve_lock_key(ctx.force, name)
      if lookup_err then return true end
      return key ~= nil and SurfaceLock.get_lock_data(key) ~= nil
    end)
    if target == "" then
      ctx.print("Usage: /belt-cargo <platform_name_or_index> [describe|abandon|restore-present]")
      ctx.print("Tip: Use /lock-status to see locked platforms")
      return
    end
    local lock_key, err = Base.resolve_lock_key(ctx.force, target)
    if err then ctx.print(err); return end
    local lock = lock_key and SurfaceLock.get_lock_data(lock_key)
    if not lock then
      ctx.print("Platform '" .. target .. "' is not locked")
      return
    end
    local name = lock.platform_name or target
    if action == "describe" then
      ctx.print("Platform '" .. name .. "': " .. SourceBeltCargo.describe(lock.cleared_belts))
      return
    end
    local force = game.forces[lock.force_name]
    local platform = force and force.platforms[lock.platform_index]
    local surface = platform and platform.valid and platform.surface or nil
    local ok, detail = SourceBeltCargo.override(lock, action, name, surface)
    if ok then
      ctx.print("Platform '" .. name .. "': " .. action .. " done (" .. tostring(detail) .. ")")
      ctx.print("The platform stays locked; /unlock-platform " .. tostring(lock_key) .. " releases it")
    else
      ctx.print("Platform '" .. name .. "': " .. action .. " refused: " .. tostring(detail))
    end
  end
)
