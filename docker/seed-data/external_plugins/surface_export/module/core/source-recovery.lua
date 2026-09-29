local SurfaceLock = require("modules/surface_export/utils/surface-lock")
local DestinationHold = require("modules/surface_export/core/destination-hold")
local PlatformLineage = require("modules/surface_export/utils/platform-lineage")
local Gateway = require("modules/surface_export/core/gateway")

local Recovery = {}

local identity = require("modules/surface_export/utils/platform-identity")

local function assign(platform)
	local existing = identity(platform)
	if existing then return existing end
	if not storage.source_recovery_epoch then return nil end
	local hub = platform.hub
	if not (hub and hub.valid and hub.unit_number) then return nil end
	storage.source_recovery_identities = storage.source_recovery_identities or {}
	local uid = storage.source_recovery_epoch .. ":" .. tostring(hub.unit_number)
	storage.source_recovery_identities[platform.index] = {
		uid = uid, surface_index = platform.surface.index, hub_unit_number = hub.unit_number, legacy = true,
	}
	return uid
end

local function had_identity(platform)
	local uid = identity(platform)
	if not uid then return false end
	local record = (storage.source_recovery_identities or {})[platform.index]
	return not (record and record.uid == uid and record.legacy == true)
end

local function protect(platform)
	if SurfaceLock.destination_hold_owns_surface(platform.surface, platform) then return end
	local lock = SurfaceLock.get_lock_data(platform.index)
	if not lock then
		local ok, err = SurfaceLock.lock_platform(platform, platform.force, {kind = "startup"})
		if not ok then error("Startup platform protection failed: " .. tostring(err)) end
	end
end

local function job_owns(platform_index)
	for _, job in pairs(storage.async_jobs or {}) do
		if job.platform_index == platform_index or (job.target_platform and job.target_platform.valid
			and job.target_platform.index == platform_index) then return true end
	end
	return false
end

local function find_platform(platform_index)
	for _, force in pairs(game.forces) do
		local candidate = force.platforms[platform_index]
		if candidate and candidate.valid then return candidate end
	end
	return nil
end

local function decode_json(text)
	if type(text) ~= "string" then return nil end
	local ok, value = pcall(helpers.json_to_table, text)
	if not ok then
		log("[SourceRecovery] unreadable recovery JSON: " .. tostring(value))
		return nil
	end
	return value
end

local function decode_verdict(verdict_json)
	local verdict = decode_json(verdict_json)
	if type(verdict) == "table" and type(verdict.verdict) == "string" and verdict.verdict ~= "" then return verdict end
	return nil
end

local function record_notice(platform_index, platform, uid, status, reason, verdict, export_id)
	local lock = SurfaceLock.get_lock_data(platform_index)
	local notice = {platformIndex = platform_index,
		platformName = platform and platform.valid and platform.name or (lock and lock.platform_name) or nil,
		platformUid = uid, exportId = export_id, status = status, reason = reason,
		lineage = verdict and verdict.lineage or nil, generation = verdict and verdict.generation or nil,
		holderInstanceId = verdict and verdict.holderInstanceId or nil,
		holderGeneration = verdict and verdict.holderGeneration or nil}
	storage.source_recovery_notices[platform_index] = notice
	return notice
end

local function quarantine(platform_index, platform, uid, reason, verdict)
	local lock = SurfaceLock.get_lock_data(platform_index)
	if not (lock and lock.kind == "startup") then
		return {success = true, quarantined = false, notice = record_notice(platform_index, platform, uid, "protected", reason, verdict)}
	end
	lock.kind = "quarantine"
	if not lock.platform_uid then lock.platform_uid = uid end
	lock.quarantine = {reason = reason, lineage = verdict and verdict.lineage or nil,
		generation = verdict and verdict.generation or nil,
		holder_instance_id = verdict and verdict.holderInstanceId or nil,
		holder_generation = verdict and verdict.holderGeneration or nil,
		owner_job_id = (reason == "in_transit" or reason == "unresolved_handoff") and verdict
			and type(verdict.ownerJobId) == "string" and verdict.ownerJobId ~= "" and verdict.ownerJobId or nil,
		epoch = storage.source_recovery_epoch}
	return {success = true, quarantined = true, notice = record_notice(platform_index, platform, uid, "quarantined", reason, verdict)}
end

local function apply_lineage(platform, verdict, adopting)
	local current, generation = PlatformLineage.get(platform)
	if verdict.mint == true then
		if current then return false, "Platform already has a lineage" end
		if verdict.generation ~= 0 or verdict.lineage ~= PlatformLineage.mint_value(storage.source_recovery_epoch, platform) then
			return false, "Minted lineage does not match this platform"
		end
		return PlatformLineage.record(platform, verdict.lineage, 0)
	end
	if current ~= verdict.lineage or generation ~= verdict.generation then
		return false, "Platform lineage changed during recovery"
	end
	if adopting then
		if not (current and PlatformLineage.valid_generation(verdict.adoptGeneration) and verdict.adoptGeneration > generation) then
			return false, "Adoption requires a higher lineage generation"
		end
		return PlatformLineage.record(platform, current, verdict.adoptGeneration)
	end
	return true, nil
end

local function adoption_authorized(verdict, platform_index)
	local lock = SurfaceLock.get_lock_data(platform_index)
	return verdict.verdict == "rollback_other" and verdict.adopt == true and not (lock and lock.resolution_request_id)
		and storage.source_recovery_mode == "save_game" and storage.source_recovery_allow_adoption == true
		and not job_owns(platform_index)
end

function Recovery.platform_facts(platform, force, uid, had)
	local lineage, generation = PlatformLineage.get(platform)
	local lock = SurfaceLock.get_lock_data(platform.index)
	if had == nil then had = had_identity(platform) end
	return {platformIndex = platform.index, platformUid = uid or identity(platform), hadIdentity = had,
		lineage = lineage, generation = generation, hubUnitNumber = PlatformLineage.hub_unit_number(platform),
		surfaceIndex = platform.surface.index, platformName = platform.name, forceName = force.name,
		lockKind = lock and lock.kind or nil, jobOwns = job_owns(platform.index)}
end

function Recovery.notice(platform_index)
	return (storage.source_recovery_notices or {})[platform_index]
end

function Recovery.announce_pending(player)
	if not (player and player.valid and player.admin) then return 0 end
	local announced = 0
	for index, notice in pairs(storage.source_recovery_notices or {}) do
		if (notice.status == "quarantined" or notice.status == "protected") and not notice.announced then
			notice.announced = true
			announced = announced + 1
			player.print("[Surface Export] " .. tostring(notice.platformName or ("Platform " .. tostring(index)))
				.. " is quarantined on this server (" .. tostring(notice.reason or "unverified")
				.. "). Choose which copy to keep on the web interface: Surface Export > Gateways.")
		end
	end
	return announced
end

function Recovery.clear_notice(platform_index)
	if storage.source_recovery_notices then storage.source_recovery_notices[platform_index] = nil end
end

function Recovery.fresh_identity(platform, retired_export_id)
	local new_uid = storage.source_recovery_epoch .. ":" .. tostring(platform.hub.unit_number)
	storage.source_recovery_identities = storage.source_recovery_identities or {}
	storage.source_recovery_identities[platform.index] = {uid = new_uid, surface_index = platform.surface.index,
		hub_unit_number = platform.hub.unit_number}
	if retired_export_id then
		for _, passenger in pairs(storage.surface_export_passengers or {}) do
			if passenger.job_id == retired_export_id and passenger.platform_index == platform.index then passenger.platform_uid = new_uid end
		end
		for _, by_player in pairs(storage.surface_export_arrivals or {}) do
			local returned = by_player["returned:" .. retired_export_id]
			if returned and returned.platform_index == platform.index then returned.platform_uid = new_uid end
		end
	end
	return new_uid
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

function Recovery.begin(epoch, journal_id, _has_retirements, mode, allow_adoption)
	assert(type(epoch) == "string" and epoch ~= "", "Missing recovery boot identity")
	assert(type(journal_id) == "string" and journal_id ~= "", "Missing recovery journal identity")
	if storage.source_recovery_journal and storage.source_recovery_journal ~= journal_id then
		return {success = false, error = "Recovery journal differs from this save; platforms remain protected"}
	end
	storage.source_recovery_epoch = epoch
	mode = mode or "plugin_history"
	if mode ~= "plugin_history" and mode ~= "save_game" then return {success = false, error = "Invalid recovery mode"} end
	storage.source_recovery_mode = mode
	storage.source_recovery_allow_adoption = allow_adoption == true
	storage.source_recovery_notices = storage.source_recovery_notices or {}
	local roster = {}
	local present = {}
	for _, force in pairs(game.forces) do
		for _, platform in pairs(force.platforms) do
			if platform.valid and platform.surface and platform.surface.valid then
				local had = had_identity(platform)
				local uid = identity(platform) or assign(platform)
				roster[#roster + 1] = Recovery.platform_facts(platform, force, uid, had)
				present[platform.index] = true
			end
		end
	end
	-- Bound the bootstrap reply; larger worlds remain protected instead of truncating authority.
	if #roster > 500 then return {success = false, error = "Recovery roster exceeds 500 platforms"} end
	for index in pairs(storage.source_recovery_notices) do
		if not present[index] then storage.source_recovery_notices[index] = nil end
	end
	for index in pairs(storage.source_recovery_identities or {}) do
		if not present[index] then storage.source_recovery_identities[index] = nil end
	end
	PlatformLineage.prune(present)
	storage.source_recovery_journal = journal_id
	DestinationHold.reconcile_legacy()
	return {success = true, platforms = roster}
end

function Recovery.reconcile(platform_index, uid, retired_export_id, unresolved_source, verdict_json)
	local verdict = decode_verdict(verdict_json)
	local platform = find_platform(platform_index)
	if not platform then
		local orphan = SurfaceLock.get_lock_data(platform_index)
		if orphan and orphan.kind == "startup" then storage.locked_platforms[platform_index] = nil end
		storage.source_recovery_notices[platform_index] = nil
		return {success = true}
	end
	if not verdict or identity(platform) ~= uid then
		return quarantine(platform_index, platform, nil, "reconcile_error", verdict)
	end
	local lock = SurfaceLock.get_lock_data(platform_index)
	if lock then
		if lock.surface_index ~= platform.surface.index or (lock.platform_uid and lock.platform_uid ~= uid) then
			return quarantine(platform_index, platform, uid, "reconcile_error", verdict)
		end
		lock.platform_uid = uid
	end
	if retired_export_id then
		if adoption_authorized(verdict, platform_index) then
			if lock and lock.kind ~= "startup" and (lock.kind ~= "transfer" or lock.transfer_job_id ~= retired_export_id) then
				return quarantine(platform_index, platform, uid, "reconcile_error", verdict)
			end
			if SurfaceLock.destination_hold_owns_surface(platform.surface, platform) then
				return quarantine(platform_index, platform, uid, "reconcile_error", verdict)
			end
			local current, generation = PlatformLineage.get(platform)
			if current ~= verdict.lineage or generation ~= verdict.generation
				or not (PlatformLineage.valid_generation(verdict.adoptGeneration) and verdict.adoptGeneration > generation) then
				return quarantine(platform_index, platform, uid, "reconcile_error", verdict)
			end
			local new_uid = storage.source_recovery_epoch .. ":" .. tostring(platform.hub.unit_number)
			local recorded, record_err = PlatformLineage.record(platform, current, verdict.adoptGeneration)
			if not recorded then
				local refused = quarantine(platform_index, platform, uid, "reconcile_error", verdict)
				refused.error = record_err
				return refused
			end
			local ok, err = SurfaceLock.accept_restored_source(platform_index, retired_export_id)
			if not ok then
				local refused = quarantine(platform_index, platform, uid, "reconcile_error", verdict)
				refused.error = err
				return refused
			end
			storage.source_recovery_identities = storage.source_recovery_identities or {}
			storage.source_recovery_identities[platform_index] = {uid = new_uid, surface_index = platform.surface.index,
				hub_unit_number = platform.hub.unit_number}
			for _, passenger in pairs(storage.surface_export_passengers or {}) do
				if passenger.job_id == retired_export_id and passenger.platform_index == platform_index then passenger.platform_uid = new_uid end
			end
			for _, by_player in pairs(storage.surface_export_arrivals or {}) do
				local returned = by_player["returned:" .. retired_export_id]
				if returned and returned.platform_index == platform_index then returned.platform_uid = new_uid end
			end
			local notice = record_notice(platform_index, platform, new_uid, "accepted", verdict.verdict, verdict, retired_export_id)
			return {success = true, accepted = true, platformUid = new_uid, notice = notice}
		end
		protect(platform)
		lock = SurfaceLock.get_lock_data(platform_index)
		if not lock or (lock.kind ~= "startup" and lock.transfer_job_id ~= retired_export_id) then
			return quarantine(platform_index, platform, uid, "reconcile_error", verdict)
		end
		lock.kind = "transfer"
		lock.transfer_job_id = retired_export_id
		local ok, err = SurfaceLock.commit_source_transfer_lock(platform_index, retired_export_id)
		local notice = record_notice(platform_index, platform, uid, "protected", verdict.verdict, verdict, retired_export_id)
		return {success = ok, error = err, quarantined = true, notice = notice}
	end
	if lock and lock.kind == "startup" then
		if unresolved_source then
			return quarantine(platform_index, platform, uid, "unresolved_handoff", verdict)
		end
		local adopting = adoption_authorized(verdict, platform_index)
		if verdict.verdict == "normal" or adopting then
			local applied, apply_err = apply_lineage(platform, verdict, adopting)
			if not applied then
				local refused = quarantine(platform_index, platform, uid, "reconcile_error", verdict)
				refused.error = apply_err
				return refused
			end
			local ok, err = SurfaceLock.unlock_platform(platform_index, nil, true)
			if not ok then
				local refused = quarantine(platform_index, platform, uid, "reconcile_error", verdict)
				refused.error = err
				return refused
			end
			if adopting then
				return {success = true, notice = record_notice(platform_index, platform, uid, "accepted", verdict.verdict, verdict)}
			end
			local notice = storage.source_recovery_notices[platform_index]
			if notice and notice.platformUid ~= uid then storage.source_recovery_notices[platform_index] = nil; notice = nil end
			return {success = true, notice = notice}
		end
		return quarantine(platform_index, platform, uid, verdict.verdict, verdict)
	end
	local notice = storage.source_recovery_notices[platform_index]
	if notice and notice.platformUid ~= uid then storage.source_recovery_notices[platform_index] = nil; notice = nil end
	return {success = true, notice = lock and lock.kind == "quarantine" and notice or nil}
end

function Recovery.finish()
	local quarantined = 0
	for _, lock in pairs(storage.locked_platforms or {}) do
		if lock.kind == "startup" then return {success = false, error = "Unreconciled startup protection remains"} end
		if lock.kind == "quarantine" then quarantined = quarantined + 1 end
	end
	storage.source_recovery_ready = true
	return {success = true, quarantined = quarantined}
end

function Recovery.lineage_presence(lineages_json)
	if storage.source_recovery_ready ~= true then return {success = false, error = "Source recovery is not ready"} end
	local lineages = decode_json(lineages_json)
	if type(lineages) ~= "table" or #lineages > 500 then return {success = false, error = "Invalid lineage list"} end
	local answers = {}
	for index, lineage in ipairs(lineages) do
		local result, err = PlatformLineage.presence(lineage)
		if not result then return {success = false, error = err} end
		local copy = result.platform
		local aboard
		if copy then
			local counted, players, characters = pcall(Gateway.collect_passengers, copy)
			if counted then aboard = Gateway.passenger_count(players, characters)
			else log("[SourceRecovery] passenger count unavailable: " .. tostring(players)) end
		end
		answers[index] = {lineage = lineage, present = result.present, generation = result.generation, held = result.held, passengers = aboard,
			platformIndex = copy and copy.index or nil, platformUid = copy and identity(copy) or nil,
			platformName = copy and copy.name or nil, forceName = result.force and result.force.name or nil}
	end
	return {success = true, epoch = storage.source_recovery_epoch, lineages = answers}
end

function Recovery.source_identity(platform_index, force_name, job_id)
	if storage.source_recovery_ready ~= true then return {success = false, error = "Source recovery is not ready"} end
	local force = game.forces[force_name]
	local platform = force and force.platforms[platform_index]
	if not (platform and platform.valid) then return {success = true, missing = true} end
	local uid = identity(platform)
	local ok, err = SurfaceLock.transfer_delete_identity_ok(SurfaceLock.get_lock_data(platform_index), platform.surface, job_id)
	if not ok or not uid then return {success = false, error = err or "Source has no stable identity"} end
	local lineage, generation = PlatformLineage.get(platform)
	return {success = true, platformUid = uid, platformIndex = platform_index,
		surfaceIndex = platform.surface.index, forceName = force_name, exportId = job_id,
		lineage = lineage, generation = generation, hubUnitNumber = PlatformLineage.hub_unit_number(platform)}
end

function Recovery.matches(platform, uid)
	return storage.source_recovery_ready == true and identity(platform) == uid
end

function Recovery.platform_uid(platform)
	return identity(platform)
end

function Recovery.export_job_id(counter, name)
	assert(storage.source_recovery_ready == true and storage.source_recovery_epoch, "Source recovery is not ready")
	return string.format("%03d_%s_%s", counter, name, storage.source_recovery_epoch)
end

return Recovery
