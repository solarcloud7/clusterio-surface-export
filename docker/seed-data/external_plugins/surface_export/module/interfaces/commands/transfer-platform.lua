-- Command: /transfer-platform
-- Transfer a platform to another instance

local Base = require("modules/surface_export/interfaces/commands/base")
local AsyncProcessor = require("modules/surface_export/core/async-processor")
local SurfaceLock = require("modules/surface_export/utils/surface-lock")

local clusterio_api = require("modules/clusterio/api")

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

    if not clusterio_api then
      log("[Transfer Command] Clusterio API not available - aborting")
      ctx.print("✗ Clusterio not available - cannot transfer")
      return
    end

    local platform = ctx.force.platforms[platform_index]
    if not platform or not platform.valid then
      ctx.print(string.format("Error: Platform index %d not found", platform_index))
      ctx.print("Use /list-platforms to see available platforms")
      return
    end

    local platform_name = platform.name
    local force_name = ctx.force.name

    ctx.print("═══════════════════════════════════════")
    ctx.print(string.format("🚀 Transfer Platform: %s", platform_name))
    ctx.print("═══════════════════════════════════════")
    ctx.print(string.format("Destination: Instance %d", dest_instance_id))
    ctx.print(string.format("Platform: [%d] %s", platform_index, platform_name))
    ctx.print("")

    -- Step 1: Lock platform
    ctx.print("[1/3] Locking platform...")
    local lock_ok, lock_err = SurfaceLock.lock_platform(platform, ctx.force)

    if not lock_ok then
      log(string.format("[Transfer Command] Lock failed for platform '%s': %s", platform_name, lock_err or "Unknown error"))
      ctx.print(string.format("✗ Lock failed: %s", lock_err or "Unknown error"))
      return
    end
    log(string.format("[Transfer Command] Platform '%s' locked successfully", platform_name))

    ctx.print("✓ Platform locked (hidden from players)")

    -- Step 2: Queue export WITH destination instance ID for auto-transfer
    ctx.print("[2/3] Queueing export...")
    local job_id, export_err = AsyncProcessor.queue_export(platform_index, force_name, "TRANSFER", dest_instance_id)

    if not job_id then
      log(string.format("[Transfer Command] Export queue failed for platform '%s' (index %d): %s", platform_name, platform_index, export_err or "Unknown error"))
      ctx.print(string.format("✗ Export failed: %s", export_err or "Unknown error"))
      SurfaceLock.unlock_platform(platform_name)
      return
    end
    log(string.format("[Transfer Command] Export queued: job_id=%s, platform='%s', dest_instance_id=%s (type=%s)",
      job_id, platform_name, tostring(dest_instance_id), type(dest_instance_id)))

    ctx.print(string.format("✓ Export queued: %s", job_id))
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

    -- Send transfer request via Clusterio send_json event channel
    local event_payload = {
      platform_index = platform_index,
      platform_name = platform_name,
      force_name = force_name,
      destination_instance_id = dest_instance_id,
      job_id = job_id
    }
    log(string.format("[Transfer Command] Sending send_json event 'surface_transfer_request': platform='%s', dest_instance_id=%s (type=%s), job_id=%s",
      platform_name, tostring(dest_instance_id), type(dest_instance_id), job_id))
    clusterio_api.send_json("surface_transfer_request", event_payload)
  end
)
