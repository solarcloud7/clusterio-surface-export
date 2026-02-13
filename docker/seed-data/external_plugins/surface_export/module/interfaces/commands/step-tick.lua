-- Command: /step-tick
-- Unpause the game to allow ticks to process (used by integration tests)

local Base = require("modules/surface_export/interfaces/commands/base")

Base.admin_command("step-tick",
  "Unpause the game to allow async processing. Usage: /step-tick [count]",
  function(cmd, ctx)
    if game.tick_paused then
      game.tick_paused = false
      ctx.print(string.format("Game unpaused at tick %d", game.tick))
    else
      ctx.print("Game is already running")
    end
  end
)
