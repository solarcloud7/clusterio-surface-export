-- Command: /gateway-transfer
-- Transfer a platform that is PARKED at a gateway to a destination instance.
--
-- Phase 1a explicit trigger. This is the stand-in for the 1b on-arrival GUI button: both gate on
-- "parked at a gateway" and both fire the same TransferTrigger.start backend. Unlike auto-firing from
-- the arrival event, this runs OUTSIDE on_space_platform_changed_state, so it never mutates a platform
-- during its own state-change. The gateway->instance mapping is supplied explicitly here; the
-- controller-sourced config + web UI is Phase 1c.

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

    -- Gate: the platform must currently be parked AT a gateway. Reading space_location only makes
    -- sense in waiting_at_station (in flight it is nil), so check the state first.
    local sps = defines.space_platform_state
    local loc = platform.state == sps.waiting_at_station and platform.space_location or nil
    if not (loc and Gateway.is_gateway(loc.name)) then
      ctx.print(string.format("✗ Platform '%s' is not parked at a gateway (state=%s, location=%s)",
        platform.name, tostring(platform.state), tostring(loc and loc.name or "nil")))
      ctx.print("Route it to a surfexp_gateway_* and wait until it is waiting_at_station, then retry.")
      return
    end

    ctx.print(string.format("🛰  Gateway transfer: '%s' parked at '%s' → instance %d",
      platform.name, loc.name, dest_instance_id))

    local job_id, err = TransferTrigger.start(ctx.force, platform_index, dest_instance_id)
    if not job_id then
      log(string.format("[Gateway Transfer] start failed for '%s' (index %d): %s",
        platform.name, platform_index, err or "unknown"))
      ctx.print(string.format("✗ Transfer failed: %s", err or "unknown"))
      return
    end

    log(string.format("[Gateway Transfer] started: platform='%s' at gateway '%s' -> instance %s, job_id=%s",
      platform.name, loc.name, tostring(dest_instance_id), tostring(job_id)))
    ctx.print(string.format("✓ Transfer queued: %s", job_id))
    ctx.print("⏳ The transfer continues automatically (export → controller → destination import → validate).")
  end
)
