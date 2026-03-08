-- Command: /transaction-dashboard
-- Open the in-game transaction history dashboard

local Base = require("modules/surface_export/interfaces/commands/base")
local TransactionDashboard = require("modules/surface_export/interfaces/gui/transaction-dashboard")

Base.admin_command("transaction-dashboard",
  "Open the transaction history dashboard (shows import/export/transfer history with timing)",
  function(cmd, ctx)
    local player = game.players[ctx.player_index]
    if not player then
      ctx.print("This command can only be run by a player (not console)")
      return
    end
    
    -- Parse optional limit argument
    local limit = 25
    if cmd.parameter and cmd.parameter ~= "" then
      limit = tonumber(cmd.parameter)
      if not limit or limit < 1 or limit > 500 then
        ctx.print("Invalid limit. Usage: /transaction-dashboard [limit] (1-500, default: 25)")
        return
      end
    end
    
    TransactionDashboard.open(player, limit)
  end
)
