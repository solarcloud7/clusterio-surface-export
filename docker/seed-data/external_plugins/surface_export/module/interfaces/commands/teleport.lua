-- Command: /teleport
-- Admin GUI to connect to another cluster instance: dropdown of instances (from the controller
-- roster) + Connect, which fires the player's native connect_to_server prompt.

local Base = require("modules/surface_export/interfaces/commands/base")
local TeleportGui = require("modules/surface_export/interfaces/gui/teleport-gui")

Base.admin_command("teleport",
  "Open the server teleport GUI (admin): pick another instance and connect to it",
  function(command, ctx)
    if not ctx.player then
      ctx.print("/teleport needs a player — connect_to_server shows an in-client prompt (RCON has no client).")
      return
    end
    -- Fresh roster every open (instances start/stop; addresses are assigned at instance start).
    TeleportGui.request_roster()
    TeleportGui.open(ctx.player)
  end)
