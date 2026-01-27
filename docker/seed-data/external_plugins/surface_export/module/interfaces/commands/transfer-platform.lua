-- Command: /transfer-platform
-- Transfer a platform to another instance

local Base = require("modules/surface_export/interfaces/commands/base")
local AsyncProcessor = require("modules/surface_export/core/async-processor")
local SurfaceLock = require("modules/surface_export/utils/surface-lock")

local clusterio_api
if script.active_mods["clusterio_lib"] then
  clusterio_api = require("__clusterio_lib__/api")
end

Base.admin_command("transfer-platform",
  "Transfer a platform to another instance (usage: /transfer-platform <platform_index> <destination_instance_id>)",
  function(cmd, ctx)
    local params = Base.parse_params(ctx.param)
    local platform_index = tonumber(params[1])
    local dest_instance_id = tonumber(params[2])

    if not platform_index or not dest_instance_id then
      ctx.print("Usage: /transfer-platform <platform_index> <destination_instance_id>")
      ctx.print("Example: /transfer-platform 1 2")
      ctx.print("Tip: Use /list-platforms to see platform indices")
      return
    end

    if not clusterio_api then
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
      ctx.print(string.format("✗ Lock failed: %s", lock_err or "Unknown error"))
      return
    end

    ctx.print("✓ Platform locked (hidden from players)")

    -- Step 2: Queue export WITH destination instance ID for auto-transfer
    ctx.print("[2/3] Queueing export...")
    local job_id, export_err = AsyncProcessor.queue_export(platform_index, force_name, "TRANSFER", dest_instance_id)

    if not job_id then
      ctx.print(string.format("✗ Export failed: %s", export_err or "Unknown error"))
      SurfaceLock.unlock_platform(platform_name)
      return
    end

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

    -- Send transfer request via IPC
    clusterio_api.send_json("surface_transfer_request", {
      platform_index = platform_index,
      platform_name = platform_name,
      force_name = force_name,
      destination_instance_id = dest_instance_id,
      job_id = job_id
    })
  end
)
