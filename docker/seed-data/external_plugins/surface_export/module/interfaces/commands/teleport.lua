-- Command: /teleport
-- GUI to connect to another cluster instance: dropdown of instances (from the controller roster)
-- + Connect, which fires the player's native connect_to_server prompt.
--
-- ACCESS: admins, plus members of the Factorio permission group named by
-- TeleportGui.PERMISSION_GROUP ("Teleport") — save-persisted, managed via the stock /permissions
-- GUI, pre-created at startup. The gate lives in TeleportGui.is_allowed (one place; the GUI's
-- Connect button re-checks it so revocation takes effect even with the GUI open).

local Base = require("modules/surface_export/interfaces/commands/base")
local TeleportGui = require("modules/surface_export/interfaces/gui/teleport-gui")

Base.command("teleport",
  "Open the server teleport GUI: pick another instance and connect to it (admins + the 'Teleport' permission group)",
  function(command, ctx)
    if not ctx.player then
      ctx.print("/teleport needs a player — connect_to_server shows an in-client prompt (RCON has no client).")
      return
    end
    if not TeleportGui.is_allowed(ctx.player) then
      ctx.print(string.format(
        "Only admins or members of the '%s' permission group can use /teleport. " ..
        "Admins: open /permissions and move the player into that group.",
        TeleportGui.PERMISSION_GROUP))
      return
    end
    -- Fresh roster every open (instances start/stop; addresses are assigned at instance start).
    TeleportGui.request_roster()
    TeleportGui.open(ctx.player)
  end)
