local SurfaceLock = require("modules/surface_export/utils/surface-lock")
local PlatformLineage = require("modules/surface_export/utils/platform-lineage")
local SourceRecovery = require("modules/surface_export/core/source-recovery")
local AsyncProcessor = require("modules/surface_export/core/async-processor")
local Gateway = require("modules/surface_export/core/gateway")

local Resolution = {}

local function records()
	storage.surface_export_resolutions = storage.surface_export_resolutions or {}
	return storage.surface_export_resolutions
end

local function find_platform(platform_index)
	for _, force in pairs(game.forces) do
		local platform = force.platforms[platform_index]
		if platform and platform.valid then return platform, force end
	end
	return nil, nil
end

local function decode(request_json)
	if type(request_json) ~= "string" then return nil end
	local ok, value = pcall(helpers.json_to_table, request_json)
	if not ok then
		log("[Resolution] unreadable request: " .. tostring(value))
		return nil
	end
	if type(value) ~= "table" or type(value.requestId) ~= "string" or value.requestId == "" or type(value.step) ~= "string"
		or type(value.platformIndex) ~= "number" then return nil end
	return value
end

local function valid_token(token)
	return type(token) == "string" and #token >= 32
end

local function passengers(platform)
	local ok, players, characters = pcall(Gateway.collect_passengers, platform)
	if not ok then
		log("[Resolution] passenger count unavailable: " .. tostring(players))
		return nil
	end
	return Gateway.passenger_count(players, characters)
end

function Resolution.passengers(platform)
	return passengers(platform)
end

local function reidentify(platform, lock)
	if lock.kind ~= "quarantine" or lock.platform_uid or lock.surface_index ~= platform.surface.index then return end
	local uid = SourceRecovery.platform_uid(platform)
	if uid then lock.platform_uid = uid end
end

function Resolution.candidates()
	if storage.source_recovery_ready ~= true then return {success = false, error = "Source recovery is not ready"} end
	local list = {}
	for _, force in pairs(game.forces) do
		for _, platform in pairs(force.platforms) do
			local lock = platform.valid and SurfaceLock.get_lock_data(platform.index)
			local notice = platform.valid and SourceRecovery.notice(platform.index)
			local tombstone = lock and lock.kind == "transfer" and SurfaceLock.source_lock_is_committed(lock)
				and notice and notice.status == "protected"
			if lock and (lock.kind == "quarantine" or tombstone or lock.resolution_request_id) then
				reidentify(platform, lock)
				local facts = SourceRecovery.platform_facts(platform, force)
				local quarantine = lock.quarantine or {}
				facts.reason = lock.kind == "quarantine" and quarantine.reason or (notice and notice.reason) or nil
				facts.state = lock.resolution_request_id and "resolving" or (tombstone and "tombstone") or "quarantine"
				facts.ownerJobId = quarantine.owner_job_id
				facts.holderInstanceId = quarantine.holder_instance_id
				facts.holderGeneration = quarantine.holder_generation
				facts.retiredExportId = tombstone and lock.transfer_job_id or (lock.resolution_restore and lock.resolution_restore.transfer_job_id) or nil
				facts.resolutionRequestId = lock.resolution_request_id
				facts.passengers = passengers(platform)
				list[#list + 1] = facts
			end
		end
	end
	return {success = true, epoch = storage.source_recovery_epoch, platforms = list}
end

local function verify(request)
	local platform, force = find_platform(request.platformIndex)
	if not platform then return nil, nil, "Platform no longer exists" end
	if SourceRecovery.platform_uid(platform) ~= request.platformUid then return nil, nil, "Platform identity changed" end
	return platform, force, nil
end

local function owns(record, request, action)
	return record.platform_index == request.platformIndex and record.platform_uid == request.platformUid
		and record.action == action and record.token == request.token
end

local function prepare_delete(request)
	if not valid_token(request.token) then return {success = false, error = "Resolution token is required"} end
	local all = records()
	local record = all[request.requestId]
	if record then
		if not owns(record, request, "delete") then return {success = false, error = "Resolution request belongs to another platform"} end
		return {success = true, jobId = record.job_id}
	end
	local platform, force, err = verify(request)
	if not platform then return {success = false, error = err} end
	local lock = SurfaceLock.get_lock_data(platform.index)
	local converted = false
	if lock then
		local ok, convert_err = SurfaceLock.convert_for_resolution(platform.index, request.requestId)
		if not ok then return {success = false, error = convert_err} end
		converted = true
	end
	record = {action = "delete", platform_index = platform.index, platform_uid = request.platformUid, release = false, token = request.token}
	all[request.requestId] = record
	local job_id, queue_err = AsyncProcessor.queue_export(platform.index, force.name, "resolution", nil, nil, nil,
		"resolution:" .. request.requestId, request.platformUid, nil, "resolution")
	if not job_id then
		if converted then SurfaceLock.restore_resolution_protection(SurfaceLock.get_lock_data(platform.index)) end
		all[request.requestId] = nil
		return {success = false, error = "Resolution snapshot refused: " .. tostring(queue_err)}
	end
	record.job_id = job_id
	return {success = true, jobId = job_id}
end

local function retarget(request)
	local record = records()[request.requestId]
	if not (record and owns(record, request, "delete")) then return {success = false, error = "Resolution request belongs to another platform"} end
	local lock = SurfaceLock.get_lock_data(request.platformIndex)
	if not (lock and lock.resolution_request_id == request.requestId and type(lock.resolution_restore) == "table") then
		return {success = false, error = "The copy is not held for this resolution"}
	end
	if type(request.exportId) ~= "string" or request.exportId == "" then return {success = false, error = "Retirement export identity is required"} end
	if lock.transfer_job_id == request.exportId then return {success = true} end
	if SurfaceLock.source_lock_is_committed(lock) then return {success = false, error = "The deletion is already committed"} end
	if (storage.async_jobs or {})[record.job_id] then return {success = false, error = "The resolution snapshot is still running"} end
	local original = lock.resolution_restore.transfer_job_id
	if original ~= nil and original ~= request.exportId then return {success = false, error = "The copy was retired by another transfer"} end
	lock.transfer_job_id = request.exportId
	record.retired_export_id = request.exportId
	return {success = true}
end

local function releasable(platform)
	return SurfaceLock.is_resolution_candidate(SurfaceLock.get_lock_data(platform.index))
end

local function authorize(request)
	if not valid_token(request.token) then return {success = false, error = "Resolution token is required"} end
	local all = records()
	local record = all[request.requestId]
	if record then
		if not owns(record, request, "release") then return {success = false, error = "Resolution request belongs to another platform"} end
		return {success = true}
	end
	local platform, _, err = verify(request)
	if not platform then return {success = false, error = err} end
	if not releasable(platform) then return {success = false, error = "Platform is not quarantined or tombstoned"} end
	all[request.requestId] = {action = "release", platform_index = platform.index, platform_uid = request.platformUid,
		release = true, token = request.token}
	return {success = true}
end

local function mint(request)
	if not valid_token(request.token) then return {success = false, error = "Resolution token is required"} end
	local all = records()
	local record = all[request.requestId]
	if record and not owns(record, request, "release") then
		return {success = false, error = "Resolution request belongs to another platform"}
	end
	if not record then return {success = false, error = "The resolution was not authorized for this platform"} end
	local platform, _, err = verify(request)
	if not platform then return {success = false, error = err} end
	if record.lineage then return {success = true, lineage = record.lineage, generation = 0} end
	if not releasable(platform) then return {success = false, error = "Platform is not quarantined or tombstoned"} end
	if PlatformLineage.get(platform) then return {success = false, error = "Platform already has a lineage"} end
	local lineage = PlatformLineage.mint_value(storage.source_recovery_epoch, platform)
	if not lineage then return {success = false, error = "Platform lineage is unavailable"} end
	local recorded, record_err = PlatformLineage.record(platform, lineage, 0)
	if not recorded then return {success = false, error = record_err} end
	record.lineage = lineage
	return {success = true, lineage = lineage, generation = 0}
end

local function held_elsewhere(lineage, platform_index)
	for _, hold in pairs(storage.destination_holds or {}) do
		if type(hold) == "table" and hold.lineage == lineage then return true end
	end
	for index, record in pairs(storage.surface_export_lineages or {}) do
		if index ~= platform_index and record.lineage == lineage then
			local other = find_platform(index)
			if other and PlatformLineage.get(other) == lineage then return true end
		end
	end
	return false
end

local function release(request)
	local all = records()
	local record = all[request.requestId]
	if not record or record.action ~= "release" or record.platform_index ~= request.platformIndex or not valid_token(request.token)
		or record.token ~= request.token then
		return {success = false, error = "The resolution was not authorized for this platform"}
	end
	if record.released then return {success = true, platformUid = record.released_uid} end
	if record.platform_uid ~= request.platformUid then return {success = false, error = "Resolution request belongs to another platform"} end
	local platform, _, err = verify(request)
	if not platform then return {success = false, error = err} end
	if not releasable(platform) then return {success = false, error = "Platform is not quarantined or tombstoned"} end
	if request.lineage ~= nil then
		local current = PlatformLineage.get(platform)
		local minted = current == nil and request.generation == 0
			and PlatformLineage.mint_value(storage.source_recovery_epoch, platform) == request.lineage
		if current ~= request.lineage and not minted then return {success = false, error = "Platform lineage changed"} end
		if held_elsewhere(request.lineage, platform.index) then
			return {success = false, error = "Another local copy or destination hold carries this lineage"}
		end
		if not PlatformLineage.valid_generation(request.generation) then return {success = false, error = "Invalid lineage generation"} end
	end
	local lock = SurfaceLock.get_lock_data(platform.index)
	local retired_export_id = lock.kind == "transfer" and lock.transfer_job_id or nil
	if request.lineage ~= nil then
		local recorded, record_err = PlatformLineage.record(platform, request.lineage, request.generation)
		if not recorded then return {success = false, error = record_err} end
	end
	local ok, release_err = SurfaceLock.release_for_resolution(platform.index, request.requestId)
	if not ok then return {success = false, error = release_err} end
	local uid = request.platformUid
	if retired_export_id or request.refreshIdentity == true then uid = SourceRecovery.fresh_identity(platform, retired_export_id) end
	SourceRecovery.clear_notice(platform.index)
	record.released = true
	record.released_uid = uid
	return {success = true, platformUid = uid}
end

local function restore(request)
	local record = records()[request.requestId]
	if not (record and record.action == "delete" and record.platform_index == request.platformIndex and record.token == request.token) then
		return {success = true, restored = false}
	end
	if record.abandoned then return {success = true, restored = true} end
	local platform = find_platform(request.platformIndex)
	if not platform or SourceRecovery.platform_uid(platform) ~= record.platform_uid then
		return {success = false, committed = true, error = "The copy no longer exists; its deletion may already have completed"}
	end
	local lock = SurfaceLock.get_lock_data(request.platformIndex)
	if lock and SurfaceLock.source_lock_is_committed(lock) and (lock.resolution_request_id == request.requestId
		or (record.job_id and lock.transfer_job_id == record.job_id)
		or (record.retired_export_id and lock.transfer_job_id == record.retired_export_id)) then
		return {success = false, committed = true, error = "The deletion is already committed"}
	end
	if lock and lock.resolution_request_id == request.requestId then
		SurfaceLock.restore_resolution_protection(lock)
	elseif lock and lock.kind == "transfer" and record.job_id and lock.transfer_job_id == record.job_id then
		local unlocked, unlock_err = SurfaceLock.unlock_platform(request.platformIndex, nil, nil, nil, record.job_id)
		if not unlocked then return {success = false, error = unlock_err} end
	end
	record.abandoned = true
	return {success = true, restored = true}
end

function Resolution.apply(request_json)
	if storage.source_recovery_ready ~= true then return {success = false, error = "Source recovery is not ready"} end
	local request = decode(request_json)
	if not request then return {success = false, error = "Invalid resolution request"} end
	if request.step == "prepare_delete" then return prepare_delete(request) end
	if request.step == "retarget" then return retarget(request) end
	if request.step == "authorize" then return authorize(request) end
	if request.step == "mint" then return mint(request) end
	if request.step == "release" then return release(request) end
	if request.step == "restore" then return restore(request) end
	return {success = false, error = "Unknown resolution step"}
end

return Resolution
