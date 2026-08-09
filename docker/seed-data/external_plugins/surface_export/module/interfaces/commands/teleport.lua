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
    TeleportGui.request_roster()
    TeleportGui.open(ctx.player)
  end)
