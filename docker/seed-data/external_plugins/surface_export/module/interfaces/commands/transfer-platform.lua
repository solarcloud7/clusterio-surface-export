-- Command: /transfer-platform
-- Transfer a platform to another instance

local Base = require("modules/surface_export/interfaces/commands/base")
local TransferTrigger = require("modules/surface_export/core/transfer-trigger")

Base.admin_command("transfer-platform",
  "Transfer a platform to another instance (usage: /transfer-platform <platform_index> <destination_instance_id>)",
  function(cmd, ctx)
    local params = Base.parse_params(ctx.param)
    local raw_param1 = params[1]
    local raw_param2 = params[2]
    local platform_index = tonumber(raw_param1)
    local dest_instance_id = tonumber(raw_param2)

    log(string.format("[Transfer Command] /transfer-platform invoked by %s: raw_params=['%s', '%s'] -> platform_index=%s, dest_instance_id=%s",
      tostring(ctx.player_index or "RCON"),
      tostring(raw_param1), tostring(raw_param2),
      tostring(platform_index), tostring(dest_instance_id)))

    if not platform_index or not dest_instance_id then
      log("[Transfer Command] Invalid parameters - aborting")
      ctx.print("Usage: /transfer-platform <platform_index> <destination_instance_id>")
      ctx.print("Example: /transfer-platform 1 2")
      ctx.print("Tip: Use /list-platforms to see platform indices")
      return
    end

    -- (Clusterio-availability is checked by TransferTrigger.start, surfaced via the failure branch below.)
    local platform = ctx.force.platforms[platform_index]
    if not platform or not platform.valid then
      ctx.print(string.format("Error: Platform index %d not found", platform_index))
      ctx.print("Use /list-platforms to see available platforms")
      return
    end

    local platform_name = platform.name

    ctx.print("═══════════════════════════════════════")
    ctx.print(string.format("🚀 Transfer Platform: %s", platform_name))
    ctx.print("═══════════════════════════════════════")
    ctx.print(string.format("Destination: Instance %d", dest_instance_id))
    ctx.print(string.format("Platform: [%d] %s", platform_index, platform_name))
    ctx.print("")

    -- Lock + queue export + send transfer request (shared with /gateway-transfer).
    ctx.print("[1/2] Locking + queueing export...")
    local job_id, err = TransferTrigger.start(ctx.force, platform_index, dest_instance_id)
    if not job_id then
      log(string.format("[Transfer Command] Transfer start failed for platform '%s' (index %d): %s", platform_name, platform_index, err or "Unknown error"))
      ctx.print(string.format("✗ Transfer failed: %s", err or "Unknown error"))
      return
    end
    log(string.format("[Transfer Command] Transfer started: job_id=%s, platform='%s', dest_instance_id=%s (type=%s)",
      job_id, platform_name, tostring(dest_instance_id), type(dest_instance_id)))

    ctx.print(string.format("[2/2] ✓ Export queued: %s", job_id))
    ctx.print("⏳ Exporting asynchronously (this may take a while)...")
    ctx.print("")
    ctx.print("The transfer will continue automatically:")
    ctx.print("  1. Export completes → Sent to controller")
    ctx.print("  2. Controller → Sends to destination instance")
    ctx.print("  3. Destination imports → Validates counts")
    ctx.print("  4. On success → Source deleted automatically")
    ctx.print("  5. On failure → Source unlocked automatically")
    ctx.print("")
    ctx.print("💡 Use /list-platforms to track progress")
    ctx.print("═══════════════════════════════════════")
  end
)
