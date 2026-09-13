local GameUtils = require("modules/surface_export/utils/game-utils")
local SurfaceLock = require("modules/surface_export/utils/surface-lock")
local Receipts = require("modules/surface_export/utils/transfer-receipts")
local platform_identity = require("modules/surface_export/utils/platform-identity")

local DestinationHold = {}

local function ensure_storage()
	storage.destination_holds = storage.destination_holds or {}
	return storage.destination_holds
end

local function entity_key(entity)
	if entity.unit_number then return tostring(entity.unit_number) end
	return GameUtils.make_stable_id(entity)
end

local function has_location(record)
	return type(record.force_name) == "string" and record.force_name ~= ""
		and type(record.platform_index) == "number" and record.platform_index > 0
		and record.platform_index % 1 == 0
end

local function find_platform(force, platform_index)
	if not (force and force.valid and platform_index) then return nil end
	platform_index = tonumber(platform_index)
	if not platform_index then return nil end
	local platform = force.platforms[platform_index]
	if platform and platform.valid and platform.index == platform_index then
		return platform
	end
	return nil
end

local function capture_and_deactivate(surface, active_states)
	active_states = active_states or {}
	local deactivated = 0
	for _, entity in pairs(surface.find_entities_filtered({})) do
		if entity.valid and GameUtils.ACTIVATABLE_ENTITY_TYPES[entity.type] then
			local key = entity_key(entity)
			active_states[key] = entity.active == true
			if entity.active then
				entity.disabled_by_script = true
				deactivated = deactivated + 1
			end
		end
	end
	return deactivated
end

local function restore_active_states(surface, active_states)
	local restored = 0
	local kept_inactive = 0
	active_states = active_states or {}
	for _, entity in pairs(surface.find_entities_filtered({})) do
		if entity.valid and GameUtils.ACTIVATABLE_ENTITY_TYPES[entity.type] then
			local was_active = active_states[entity_key(entity)]
			if was_active then
				if not entity.active then
					entity.disabled_by_script = false
					restored = restored + 1
				end
			else
				if entity.active then
					entity.disabled_by_script = true
				end
				kept_inactive = kept_inactive + 1
			end
		end
	end
	return restored, kept_inactive
end

local function matches(record, platform, job_id)
	return platform and platform.valid and platform.surface and platform.surface.valid
		and record.platform_index == platform.index and record.surface_index == platform.surface.index
		and type(record.platform_uid) == "string" and record.platform_uid ~= ""
		and record.platform_uid == platform_identity(platform)
		and type(record.job_id) == "string" and record.job_id ~= ""
		and (not job_id or record.job_id == job_id)
end

local function resolve_hold(transfer_id, job_id)
	local holds = ensure_storage()
	local hold = holds[transfer_id]
	if not hold then
		return nil, nil, nil, "No destination hold for transfer_id " .. tostring(transfer_id)
	end
	if not has_location(hold) then
		return hold, nil, nil, "Held platform location is unavailable"
	end
	local force = game.forces[hold.force_name]
	local platform = find_platform(force, hold.platform_index)
	if not (platform and platform.valid) then
		return hold, force, nil, "Held platform is missing"
	end
	if not matches(hold, platform, job_id) then
		return hold, force, platform, "Held platform or job identity changed or is unavailable"
	end
	return hold, force, platform, nil
end

function DestinationHold.reconcile_legacy()
	local function reconcile(record, transfer_id)
		if record.platform_uid and record.job_id then return end
		local platform = has_location(record) and find_platform(game.forces[record.force_name], record.platform_index)
		local uid = platform and platform.valid and platform.surface and platform.surface.valid
			and platform_identity(platform)
		local owner
		for _, job in pairs(storage.async_jobs or {}) do
			if uid and type(job.job_id) == "string" and job.type == "import" and (job.transfer_id or ("interrupted:" .. job.job_id)) == transfer_id
				and job.target_platform == platform and job.target_surface == platform.surface
				and job.force_name == record.force_name then
				if owner then owner = nil; break end
				owner = job
			end
		end
		if uid and owner and record.surface_index == platform.surface.index
			and (not record.platform_uid or record.platform_uid == uid)
			and (not record.job_id or record.job_id == owner.job_id) then
			record.platform_uid, record.job_id = uid, owner.job_id
			record.identity_unverified = nil
		else
			if not record.identity_unverified then
				log("[DestinationHold] Legacy identity unavailable for " .. transfer_id .. "; manual reconciliation required")
			end
			record.identity_unverified = true
		end
	end
	for transfer_id, hold in pairs(ensure_storage()) do reconcile(hold, transfer_id) end
	local bucket = (storage.surface_export_transfer_receipts or {}).destination_live
	for transfer_id, receipt in pairs(bucket and bucket.records or {}) do reconcile(receipt, transfer_id) end
end

local function find_hub(surface)
	for _, entity in pairs(surface.find_entities_filtered({ name = "space-platform-hub" })) do
		if entity.valid then return entity end
	end
	return nil
end

local function find_hold_for_platform(holds, surface_index, platform_index, except_transfer_id)
	for other_transfer_id, hold in pairs(holds) do
		if other_transfer_id ~= except_transfer_id
			and hold.surface_index == surface_index
			and hold.platform_index == platform_index then
			return other_transfer_id, hold
		end
	end
	return nil, nil
end

function DestinationHold.stage(transfer_id, platform, force, fail_closed, preparation_visibility, job_id)
	if type(transfer_id) ~= "string" or transfer_id == "" then
		return false, "transfer_id is required"
	end
	if not (platform and platform.valid) then
		return false, "platform is invalid"
	end
	force = force or platform.force
	if not (force and force.valid) then
		return false, "force is invalid"
	end
	local surface = platform.surface
	if not (surface and surface.valid) then
		return false, "platform surface is invalid"
	end

	local holds = ensure_storage()
	local uid = platform_identity(platform)
	if not uid then return false, "Destination platform identity is unavailable" end
	job_id = job_id or transfer_id
	local existing = holds[transfer_id]
	if Receipts.get("destination_live", transfer_id) then
		return false, "Destination transfer already released"
	end
	if existing then
		if existing.preparation_failed then return false, "Previous destination preparation failed" end
		if existing.force_name == force.name and matches(existing, platform, job_id) then
			return true, existing
		end
		return false, "transfer_id already holds a different destination platform"
	end
	local other_transfer_id = find_hold_for_platform(holds, surface.index, platform.index, transfer_id)
	if other_transfer_id then
		return false, "platform is already held by transfer_id " .. tostring(other_transfer_id)
	end

	local original_hidden = force.get_surface_hidden(surface)
	local original_platform_hidden = platform.hidden
	if preparation_visibility then
		original_hidden = preparation_visibility.surface_hidden
		original_platform_hidden = preparation_visibility.platform_hidden
	end
	local original_paused = platform.paused == true
	local active_states = {}
	local deactivated = 0
	local pod_completion = { descending = 0, ascending = 0, items_recovered = 0 }
	local hold = {
		transfer_id = transfer_id, force_name = force.name, platform_index = platform.index,
		platform_name = platform.name, surface_index = surface.index,
		platform_uid = uid, job_id = job_id,
		original_hidden = original_hidden, original_platform_hidden = original_platform_hidden,
		original_paused = original_paused, active_states = active_states, held_tick = game.tick,
		preparation_failed = true,
	}
	if fail_closed then holds[transfer_id] = hold end
	local staged_ok, staged_err = pcall(function()
		platform.paused = true
		force.set_surface_hidden(surface, true)
		platform.hidden = true
		deactivated = capture_and_deactivate(surface, active_states)
		local hub = find_hub(surface)
		local descending, ascending, items_recovered = SurfaceLock.complete_cargo_pods(surface, hub)
		pod_completion = { descending = descending, ascending = ascending, items_recovered = items_recovered }
	end)
	if not staged_ok then
		log(string.format("[DestinationHold] stage failed for transfer %s on platform '%s': %s",
			transfer_id, platform.name, tostring(staged_err)))
		-- Production transfers retain the quarantine on a partial staging failure.
		-- Only a successful destination discard may release this failed hold.
		if fail_closed then return false, "Failed to stage destination hold: " .. tostring(staged_err) end
		local restore_ok, restore_err = pcall(function()
			restore_active_states(surface, active_states)
			force.set_surface_hidden(surface, original_hidden == true)
			platform.hidden = original_platform_hidden
			platform.paused = original_paused == true
		end)
		if not restore_ok then
			log(string.format("[DestinationHold] stage rollback failed for transfer %s on platform '%s': %s",
				transfer_id, platform.name, tostring(restore_err)))
		end
		return false, "Failed to stage destination hold: " .. tostring(staged_err)
	end

	hold.preparation_failed = nil
	hold.deactivated_count = deactivated
	hold.pod_completion = pod_completion
	holds[transfer_id] = hold
	log(string.format("[DestinationHold] staged transfer %s on platform '%s' (idx=%s, surface=%s, deactivated=%d, pods=%d/%d, recovered=%d)",
		transfer_id, platform.name, tostring(platform.index), tostring(surface.index), deactivated,
		pod_completion.descending or 0, pod_completion.ascending or 0, pod_completion.items_recovered or 0))
	return true, hold
end

function DestinationHold.verify(transfer_id, job_id)
	local holds = ensure_storage()
	local receipt = Receipts.get("destination_live", transfer_id)
	if receipt then
		if holds[transfer_id] then return false, "Released transfer also has a hold" end
		local released = has_location(receipt) and find_platform(game.forces[receipt.force_name], receipt.platform_index)
		if not matches(receipt, released, job_id) then
			return false, "Released destination is missing or has changed identity"
		end
		return true, receipt
	end
	local hold, _, platform, err = resolve_hold(transfer_id, job_id)
	if err then return false, err end
	if hold.preparation_failed then return false, "Destination preparation did not finish" end
	if not platform.hidden then return false, "Destination hold visibility changed" end
	return true, hold
end

function DestinationHold.go_live(transfer_id, job_id)
	local verified, result = DestinationHold.verify(transfer_id, job_id)
	if not verified then return false, result end
	if Receipts.get("destination_live", transfer_id) then return true, result end
	local holds = ensure_storage()
	local hold, force, platform, err = resolve_hold(transfer_id, job_id)
	if err then return false, err end
	local surface = platform.surface
	local restored, kept_inactive = restore_active_states(surface, hold.active_states)
	force.set_surface_hidden(surface, hold.original_hidden == true)
	if hold.original_platform_hidden ~= nil then
		platform.hidden = hold.original_platform_hidden
	end
	platform.paused = hold.original_paused == true
	Receipts.put("destination_live", transfer_id, {
		transfer_id = transfer_id, platform_index = hold.platform_index,
		surface_index = hold.surface_index, force_name = hold.force_name, tick = game.tick,
		platform_uid = hold.platform_uid, job_id = hold.job_id,
	})
	holds[transfer_id] = nil
	log(string.format("[DestinationHold] go-live transfer %s on platform '%s' (restored=%d, kept_inactive=%d)",
		transfer_id, platform.name, restored, kept_inactive))
	return true, {
		transfer_id = transfer_id,
		platform_name = platform.name,
		platform_index = platform.index,
		surface_index = surface.index,
		restored_count = restored,
		kept_inactive_count = kept_inactive,
	}
end

function DestinationHold.discard(transfer_id, job_id)
	local holds = ensure_storage()
	local held = holds[transfer_id]
	if held and job_id and held.job_id ~= job_id then return false, "Destination cleanup job identity changed" end
	local hold, _, platform, err = resolve_hold(transfer_id, job_id)
	if err then
		if err == "Held platform is missing" then
			holds[transfer_id] = nil
			log(string.format("[DestinationHold] discard transfer %s: %s for platform '%s'; cleared hold",
				transfer_id, err, hold and hold.platform_name or "?"))
			return true, {
				transfer_id = transfer_id,
				platform_name = hold and hold.platform_name or nil,
				platform_index = hold and hold.platform_index or nil,
				surface_index = hold and hold.surface_index or nil,
				deleted = false,
				already_missing = (err == "Held platform is missing"),
			}
		end
		return false, err
	end
	local deleted = GameUtils.delete_platform(platform)
	if not deleted then return false, "Held destination deletion was refused" end
	holds[transfer_id] = nil
	log(string.format("[DestinationHold] discarded transfer %s platform '%s' (deleted=%s)",
		transfer_id, hold.platform_name, tostring(deleted)))
	return true, {
		transfer_id = transfer_id,
		platform_name = hold.platform_name,
		platform_index = hold.platform_index,
		surface_index = hold.surface_index,
		deleted = deleted,
	}
end

function DestinationHold.get(transfer_id)
	return ensure_storage()[transfer_id]
end

return DestinationHold
