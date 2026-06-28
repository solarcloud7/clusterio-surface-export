-- FactorioSurfaceExport - Transfer trigger (shared)
--
-- The one place that STARTS a cross-instance transfer: lock the source → queue an export tagged
-- TRANSFER with the destination instance → emit the send_json request the instance plugin forwards
-- to the controller. Both console entry points (/transfer-platform and /gateway-transfer) call this,
-- so the mechanic lives in exactly one place. Callers own their own user-facing printing.

local AsyncProcessor = require("modules/surface_export/core/async-processor")
local SurfaceLock = require("modules/surface_export/utils/surface-lock")
local clusterio_api = require("modules/clusterio/api")

local TransferTrigger = {}

--- Start a transfer of a platform (by its unique per-force index) to a destination instance.
--- On failure the source is left UNLOCKED (the lock is only held once an export is successfully queued).
--- @param force LuaForce The force that owns the platform.
--- @param platform_index number Per-force platform index (names are not unique — key on the index).
--- @param dest_instance_id number Destination Clusterio instance id.
--- @param gateway_target string|nil When set, this is a GATEWAY transfer: the destination parks the
---        imported platform at this gateway (paused) and strips the gateway hop. Carried explicitly
---        in the export payload (NOT inferred from the schedule). nil ⇒ ordinary transfer.
--- @return string|nil job_id The async export job id on success, or nil on failure.
--- @return string|nil err An error message on failure, or nil on success.
function TransferTrigger.start(force, platform_index, dest_instance_id, gateway_target)
	if not clusterio_api then
		return nil, "Clusterio API not available"
	end

	local platform = force.platforms[platform_index]
	if not platform or not platform.valid then
		return nil, string.format("Platform index %s not found", tostring(platform_index))
	end

	local platform_name = platform.name
	local force_name = force.name

	-- Step 1: lock the source (hidden from players, paused) for the duration of the transfer.
	local lock_ok, lock_err = SurfaceLock.lock_platform(platform, force)
	if not lock_ok then
		return nil, "Lock failed: " .. tostring(lock_err or "unknown")
	end

	-- Step 2: queue the export tagged TRANSFER with the destination — completion auto-continues the
	-- transfer (controller → destination import → validation → source delete/unlock).
	local job_id, export_err = AsyncProcessor.queue_export(platform_index, force_name, "TRANSFER", dest_instance_id, gateway_target)
	if not job_id then
		SurfaceLock.unlock_platform(platform_name)
		return nil, "Export failed: " .. tostring(export_err or "unknown")
	end

	-- Step 3: announce the transfer request so the instance plugin forwards it to the controller.
	clusterio_api.send_json("surface_transfer_request", {
		platform_index = platform_index,
		platform_name = platform_name,
		force_name = force_name,
		destination_instance_id = dest_instance_id,
		job_id = job_id,
	})

	log(string.format("[TransferTrigger] started: platform='%s' (idx %d) -> instance %s, job_id=%s",
		platform_name, platform_index, tostring(dest_instance_id), tostring(job_id)))
	return job_id, nil
end

return TransferTrigger
