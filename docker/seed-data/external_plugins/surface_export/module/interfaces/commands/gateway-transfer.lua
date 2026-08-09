local Base = require("modules/surface_export/interfaces/commands/base")
local Gateway = require("modules/surface_export/core/gateway")
local TransferTrigger = require("modules/surface_export/core/transfer-trigger")

Base.admin_command("gateway-transfer",
  "Transfer a platform parked at a gateway to a destination instance (usage: /gateway-transfer <platform_index> <destination_instance_id>)",
  function(cmd, ctx)
    local params = Base.parse_params(ctx.param)
    local platform_index = tonumber(params[1])
    local dest_instance_id = tonumber(params[2])

    if not platform_index or not dest_instance_id then
      ctx.print("Usage: /gateway-transfer <platform_index> <destination_instance_id>")
      ctx.print("The platform must be PARKED at a gateway (waiting_at_station). Use /list-platforms for indices.")
      return
    end

    local platform = ctx.force.platforms[platform_index]
    if not platform or not platform.valid then
      ctx.print(string.format("Error: Platform index %d not found", platform_index))
      ctx.print("Use /list-platforms to see available platforms")
      return
    end

    local gw_name = Gateway.parked_at_gateway(platform)
    if not gw_name then
      ctx.print(string.format("✗ Platform '%s' is not parked at a gateway (state=%s, location=%s)",
        platform.name, tostring(platform.state),
        tostring(platform.space_location and platform.space_location.name or "nil")))
      ctx.print("Route it to a surfexp_gateway_* and wait until it is waiting_at_station, then retry.")
      return
    end

    ctx.print(string.format("🛰  Gateway transfer: '%s' parked at '%s' → instance %d",
      platform.name, gw_name, dest_instance_id))

    local job_id, err = TransferTrigger.start(ctx.force, platform_index, dest_instance_id, gw_name)
    if not job_id then
      log(string.format("[Gateway Transfer] start failed for '%s' (index %d): %s",
        platform.name, platform_index, err or "unknown"))
      ctx.print(string.format("✗ Transfer failed: %s", err or "unknown"))
      return
    end

    ctx.print(string.format("✓ Transfer queued: %s", job_id))
    ctx.print("⏳ The transfer continues automatically (export → controller → destination import → validate).")
  end
)
