local SurfaceLock = require("modules/surface_export/utils/surface-lock")

local Recovery = {}

local function identity(platform)
	local record = (storage.source_recovery_identities or {})[platform.index]
	if record and record.surface_index == platform.surface.index
		and platform.hub and record.hub_unit_number == platform.hub.unit_number then return record.uid end
	local epoch = (storage.source_recovery_surface_epochs or {})[platform.surface.index]
	if epoch and platform.hub and platform.hub.valid and platform.hub.unit_number then
		return epoch .. ":" .. tostring(platform.hub.unit_number)
	end
	return nil
end

local function assign(platform)
	if identity(platform) then return identity(platform) end
	if not storage.source_recovery_epoch then return nil end
	local hub = platform.hub
	if not (hub and hub.valid and hub.unit_number) then return nil end
	storage.source_recovery_identities = storage.source_recovery_identities or {}
	local uid = storage.source_recovery_epoch .. ":" .. tostring(hub.unit_number)
	storage.source_recovery_identities[platform.index] = {
		uid = uid, surface_index = platform.surface.index, hub_unit_number = hub.unit_number,
	}
	return uid
end

local function protect(platform)
	if SurfaceLock.destination_hold_owns_surface(platform.surface, platform) then return end
	local lock = SurfaceLock.get_lock_data(platform.index)
	if not lock then
		local ok, err = SurfaceLock.lock_platform(platform, platform.force, {kind = "startup"})
		if not ok then error("Startup platform protection failed: " .. tostring(err)) end
	end
end

-- Called by Clusterio's patch-number startup event, NOT on_load (which also runs on client join).
function Recovery.startup()
	storage.source_recovery_ready = false
	storage.source_recovery_epoch = nil
	for _, force in pairs(game.forces) do
		for _, platform in pairs(force.platforms) do
			if platform.valid and platform.surface and platform.surface.valid then protect(platform) end
		end
	end
end

function Recovery.surface_created(surface_index)
	-- The surface event precedes hub construction. Save its creation epoch now;
	-- derive the platform identity once the hub exists, including after a reload.
	if not storage.source_recovery_epoch then return end
	storage.source_recovery_surface_epochs = storage.source_recovery_surface_epochs or {}
	storage.source_recovery_surface_epochs[surface_index] = storage.source_recovery_epoch
end

function Recovery.begin(epoch, journal_id, has_retirements)
	assert(type(epoch) == "string" and epoch ~= "", "Missing recovery boot identity")
	assert(type(journal_id) == "string" and journal_id ~= "", "Missing recovery journal identity")
	if storage.source_recovery_journal and storage.source_recovery_journal ~= journal_id then
		return {success = false, error = "Recovery journal differs from this save; platforms remain protected"}
	end
	storage.source_recovery_epoch = epoch
	local roster = {}
	for _, force in pairs(game.forces) do
		for _, platform in pairs(force.platforms) do
			if platform.valid and platform.surface and platform.surface.valid then
				local uid = identity(platform)
				if not uid and has_retirements then
					return {success = false, error = "Unidentified platform in an older save; manual reconciliation required"}
				end
				uid = uid or assign(platform)
				if not uid then return {success = false, error = "Platform has no stable hub identity"} end
				roster[#roster + 1] = {platformIndex = platform.index, platformUid = uid}
			end
		end
	end
	-- Bound the bootstrap reply; larger worlds remain protected instead of truncating authority.
	if #roster > 500 then return {success = false, error = "Recovery roster exceeds 500 platforms"} end
	storage.source_recovery_journal = journal_id
	return {success = true, platforms = roster}
end

function Recovery.reconcile(platform_index, uid, retired_export_id)
	local platform
	for _, force in pairs(game.forces) do
		local candidate = force.platforms[platform_index]
		if candidate and candidate.valid then platform = candidate break end
	end
	if not platform or identity(platform) ~= uid then return {success = false, error = "Recovery platform identity changed"} end
	local lock = SurfaceLock.get_lock_data(platform_index)
	if retired_export_id then
		protect(platform)
		lock = SurfaceLock.get_lock_data(platform_index)
		if not lock or (lock.kind ~= "startup" and lock.transfer_job_id ~= retired_export_id) then
			return {success = false, error = "Restored source has a conflicting lock or destination hold"}
		end
		lock.kind = "transfer"
		lock.transfer_job_id = retired_export_id
		local ok, err = SurfaceLock.commit_source_transfer_lock(platform_index, retired_export_id)
		return {success = ok, error = err, quarantined = true}
	end
	if lock and lock.kind == "startup" then
		local ok, err = SurfaceLock.unlock_platform(platform_index, nil, true)
		return {success = ok, error = err}
	end
	return {success = true}
end

function Recovery.finish()
	for _, lock in pairs(storage.locked_platforms or {}) do
		if lock.kind == "startup" then return {success = false, error = "Unreconciled startup protection remains"} end
	end
	storage.source_recovery_ready = true
	return {success = true}
end

function Recovery.source_identity(platform_index, force_name, job_id)
	if storage.source_recovery_ready ~= true then return {success = false, error = "Source recovery is not ready"} end
	local force = game.forces[force_name]
	local platform = force and force.platforms[platform_index]
	if not (platform and platform.valid) then return {success = true, missing = true} end
	local uid = identity(platform)
	local ok, err = SurfaceLock.transfer_delete_identity_ok(SurfaceLock.get_lock_data(platform_index), platform.surface, job_id)
	if not ok or not uid then return {success = false, error = err or "Source has no stable identity"} end
	return {success = true, platformUid = uid, platformIndex = platform_index,
		surfaceIndex = platform.surface.index, forceName = force_name, exportId = job_id}
end

function Recovery.matches(platform, uid)
	return storage.source_recovery_ready == true and identity(platform) == uid
end

return Recovery
