-- Command: /export-sync-mode
-- Toggle sync mode for debugging

local Base = require("modules/surface_export/interfaces/commands/base")
local AsyncProcessor = require("modules/surface_export/core/async-processor")

Base.admin_command("export-sync-mode",
  "Toggle sync mode for debugging - processes all entities in single tick. Usage: /export-sync-mode [on|off]",
  function(cmd, ctx)
    local param = ctx.param
    if not param or param == "" then
      -- Toggle
      local current = AsyncProcessor.get_sync_mode()
      AsyncProcessor.set_sync_mode(not current)
      ctx.print(string.format("Sync mode: %s", AsyncProcessor.get_sync_mode() and "ON" or "OFF"))
    elseif param == "on" or param == "true" or param == "1" then
      AsyncProcessor.set_sync_mode(true)
      ctx.print("Sync mode: ON - All entities will be processed in single tick")
    elseif param == "off" or param == "false" or param == "0" then
      AsyncProcessor.set_sync_mode(false)
      ctx.print("Sync mode: OFF - Normal async processing")
    else
      ctx.print("Usage: /export-sync-mode [on|off]")
      ctx.print("Current: " .. (AsyncProcessor.get_sync_mode() and "ON" or "OFF"))
    end
  end
)
