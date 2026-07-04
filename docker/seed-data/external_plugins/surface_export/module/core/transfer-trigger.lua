-- FactorioSurfaceExport - Transfer trigger (shared)
--
-- The one place that STARTS a cross-instance transfer: lock the source → queue an export tagged
-- TRANSFER with the destination instance → emit the send_json request the instance plugin forwards
-- to the controller. Both console entry points (/transfer-platform and /gateway-transfer) call this,
-- so the mechanic lives in exactly one place. Callers own their own user-facing printing.

local AsyncProcessor = require("modules/surface_export/core/async-processor")
local SurfaceLock = require("modules/surface_export/utils/surface-lock")
local Gateway = require("modules/surface_export/core/gateway")
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

	-- R1: refuse a SECOND transfer of an already-in-flight (locked) platform. transfer-trigger is ALWAYS the
	-- first lock in the in-game path, so is_locked here means another transfer (or an admin lock) already holds
	-- it; proceeding would queue a duplicate export → two live copies. (The universal export-pipeline self-relock
	-- uses the backfill at a different call site and is unaffected by this guard.)
	if SurfaceLock.is_locked(platform.index) then
		return nil, string.format("Platform '%s' (index %s) is already locked/transferring", platform_name, tostring(platform.index))
	end

	-- NOTE: passengers are NOT blocked. The transfer proceeds with players aboard; they are evacuated to a
	-- planet at the source-delete chokepoint (delete_platform_for_transfer → Gateway.evacuate_passengers).

	-- #86: a CONNECTED player aboard is heartbeat-DROPPED during the heavy export tick-stall (the transfer is
	-- lossless, but the client is booted — see the connected-player-transfer-drops-client memory). Two things
	-- here, BEFORE the export begins: (1) log who's aboard so it correlates with the
	-- surface_export_export_stall_seconds metric; (2) WARN each connected passenger NOW — the evacuate notice
	-- fires post-export (at delete), by which point the client has already been dropped and never sees it.
	local aboard_players, aboard_characters = Gateway.collect_passengers(platform)
	local connected = {}
	for _, p in ipairs(aboard_players) do
		if p.connected then connected[#connected + 1] = p end
	end
	if #aboard_players > 0 or aboard_characters > 0 then
		log(string.format("[TransferTrigger] '%s' (idx %d) starting transfer with %d connected + %d total player(s) aboard, %d character(s) — export tick-stall may drop connected clients (#86)",
			platform_name, platform_index, #connected, #aboard_players, aboard_characters))
	end
	for _, p in ipairs(connected) do
		-- intentional probe; best-effort pre-stall notify, a print failure must NOT abort the transfer.
		pcall(function()
			p.print({"", "🚀 '", platform_name, "' is transferring to another server — you'll return to Nauvis. A brief disconnect is possible during the transfer; just reconnect."})
		end)
	end

	-- Step 1: lock the source (hidden from players, paused) for the duration of the transfer.
	-- The export queue later backfills the generated job_id onto this same transfer lock.
	local lock_ok, lock_err = SurfaceLock.lock_platform(platform, force, {
		expires_tick = game.tick + SurfaceLock.DEFAULT_TRANSFER_LOCK_TTL_TICKS,
	})
	if not lock_ok then
		return nil, "Lock failed: " .. tostring(lock_err or "unknown")
	end

	-- Step 2: queue the export tagged TRANSFER with the destination — completion auto-continues the
	-- transfer (controller → destination import → validation → source delete/unlock).
	local job_id, export_err = AsyncProcessor.queue_export(platform_index, force_name, "TRANSFER", dest_instance_id, gateway_target)
	if not job_id then
		SurfaceLock.unlock_platform(platform.index)
		return nil, "Export failed: " .. tostring(export_err or "unknown")
	end

	-- Step 3: announce the transfer request. This only feeds the instance plugin's pendingTransfer (a LEGACY
	-- fallback) + dashboard status — the transfer itself is driven by the export-complete event, which carries
	-- the destination (export-pipeline.lua), so it proceeds even if this announce throws. GUARDED so a throw
	-- can't escape the command/GUI handler, and surfaced honestly (host log + in-game chat), but NOT fatal: do
	-- NOT unlock (that would run the queued export on a live, unfrozen platform) and do NOT report failure (the
	-- transfer is not failed — reporting it would be a lie while the source is being deleted on the far side).
	local announced, announce_err = pcall(function()
		clusterio_api.send_json("surface_transfer_request", {
			platform_index = platform_index,
			platform_name = platform_name,
			force_name = force_name,
			destination_instance_id = dest_instance_id,
			job_id = job_id,
		})
	end)
	if not announced then
		log(string.format("[TransferTrigger] announce (send_json) failed for '%s' (idx %d) — transfer still proceeds via export-complete: %s",
			platform_name, platform_index, tostring(announce_err)))
		game.print(string.format("⚠ Transfer of '%s' is proceeding; its status announce failed, so dashboard updates may lag (see log).",
			platform_name), {1, 0.8, 0})
	end

	log(string.format("[TransferTrigger] started: platform='%s' (idx %d) -> instance %s, job_id=%s",
		platform_name, platform_index, tostring(dest_instance_id), tostring(job_id)))
	return job_id, nil
end

return TransferTrigger
