local AsyncProcessor = require("modules/surface_export/core/async-processor")
local SurfaceLock = require("modules/surface_export/utils/surface-lock")
local Gateway = require("modules/surface_export/core/gateway")
local clusterio_api = require("modules/clusterio/api")

local TransferTrigger = {}

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

	if SurfaceLock.is_locked(platform.index) then
		return nil, string.format("Platform '%s' (index %s) is already locked/transferring", platform_name, tostring(platform.index))
	end


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

	local lock_ok, lock_err = SurfaceLock.lock_platform(platform, force, {
		kind = "transfer",
		expires_tick = game.tick + SurfaceLock.DEFAULT_TRANSFER_LOCK_TTL_TICKS,
	})
	if not lock_ok then
		return nil, "Lock failed: " .. tostring(lock_err or "unknown")
	end

	local job_id, export_err = AsyncProcessor.queue_export(platform_index, force_name, "TRANSFER", dest_instance_id, gateway_target)
	if not job_id then
		SurfaceLock.unlock_platform(platform.index)
		return nil, "Export failed: " .. tostring(export_err or "unknown")
	end

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
