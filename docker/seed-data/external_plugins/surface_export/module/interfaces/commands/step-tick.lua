-- Command: /step-tick
-- Advance the game by one tick (for debugging paused imports)

local Base = require("modules/surface_export/interfaces/commands/base")

Base.admin_command("step-tick",
  "Advance the game by one tick (for debugging paused imports). Usage: /step-tick [count]",
  function(cmd, ctx)
    local count = tonumber(ctx.param) or 1
    if count < 1 then count = 1 end
    if count > 3600 then count = 3600 end  -- Max 60 seconds worth of ticks
    
    local start_tick = game.tick
    
    -- Schedule repause after N ticks
    storage.step_tick_target = game.tick + count
    
    if game.tick_paused then
      game.tick_paused = false
      ctx.print(string.format("Stepping %d tick(s) from tick %d...", count, start_tick))
    else
      ctx.print("Game is not paused - use game.tick_paused = true first")
    end
  end
)
