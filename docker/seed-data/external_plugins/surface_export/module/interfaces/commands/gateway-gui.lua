local Base = require("modules/surface_export/interfaces/commands/base")
local Gateway = require("modules/surface_export/core/gateway")
local GatewayTransferGui = require("modules/surface_export/interfaces/gui/gateway-transfer")

Base.admin_command("gateway-gui",
  "Open the gateway-transfer chooser for a platform parked at a gateway (usage: /gateway-gui <platform_index>)",
  function(cmd, ctx)
    if not ctx.player then
      ctx.print("This command must be run by a player (it opens an in-game window).")
      return
    end

    local params = Base.parse_params(ctx.param)
    local platform_index = tonumber(params[1])
    if not platform_index then
      ctx.print("Usage: /gateway-gui <platform_index>   (use /list-platforms for indices)")
      return
    end

    local platform = ctx.force.platforms[platform_index]
    if not platform or not platform.valid then
      ctx.print(string.format("Error: Platform index %d not found. Use /list-platforms.", platform_index))
      return
    end

    local gw_name = Gateway.parked_at_gateway(platform)
    if not gw_name then
      ctx.print(string.format("✗ Platform '%s' is not parked at a gateway (state=%s, location=%s).",
        platform.name, tostring(platform.state),
        tostring(platform.space_location and platform.space_location.name or "nil")))
      ctx.print("Route it to a surfexp_gateway_* and wait until it is waiting_at_station, then retry.")
      return
    end

    if not GatewayTransferGui.open(ctx.player, platform, gw_name) then
      return
    end
    ctx.print(string.format("Opened the gateway chooser for '%s' (at '%s').", platform.name, gw_name))
  end
)
