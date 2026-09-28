local SurfaceLock = require("modules/surface_export/utils/surface-lock")

local PlatformLineage = {}

PlatformLineage.PREFIX = "lineage:"

function PlatformLineage.valid(lineage)
	return type(lineage) == "string" and #lineage <= 200 and lineage:match("^lineage:[^:%s]+:[1-9]%d*$") ~= nil
end

function PlatformLineage.valid_generation(generation)
	return type(generation) == "number" and generation >= 0 and generation % 1 == 0 and generation < 2 ^ 53
end

local function hub_of(platform)
	if not (platform and platform.valid and platform.surface and platform.surface.valid) then return nil end
	local hub = platform.hub
	if not (hub and hub.valid) then return nil end
	if not hub.unit_number then return nil end
	return hub
end

function PlatformLineage.hub_unit_number(platform)
	local hub = hub_of(platform)
	return hub and hub.unit_number or nil
end

function PlatformLineage.mint_value(epoch, platform)
	local hub = hub_of(platform)
	if not (hub and type(epoch) == "string" and epoch ~= "") then return nil end
	local lineage = PlatformLineage.PREFIX .. epoch .. ":" .. tostring(hub.unit_number)
	if not PlatformLineage.valid(lineage) then return nil end
	return lineage
end

function PlatformLineage.get(platform)
	local hub = hub_of(platform)
	if not hub then return nil end
	local record = (storage.surface_export_lineages or {})[platform.index]
	if record and record.surface_index == platform.surface.index and record.hub_unit_number == hub.unit_number
		and PlatformLineage.valid(record.lineage) and PlatformLineage.valid_generation(record.generation) then
		return record.lineage, record.generation
	end
	return nil
end

local function held_by_other(lineage, platform_index)
	for index, record in pairs(storage.surface_export_lineages or {}) do
		if index ~= platform_index and record.lineage == lineage then return true end
	end
	return false
end

function PlatformLineage.record(platform, lineage, generation)
	local hub = hub_of(platform)
	if not hub then return false, "Platform has no stable hub identity" end
	if not PlatformLineage.valid(lineage) then return false, "Invalid platform lineage" end
	if not PlatformLineage.valid_generation(generation) then return false, "Invalid lineage generation" end
	if held_by_other(lineage, platform.index) then return false, "Another local platform carries this lineage" end
	storage.surface_export_lineages = storage.surface_export_lineages or {}
	storage.surface_export_lineages[platform.index] = {
		lineage = lineage, generation = generation,
		surface_index = platform.surface.index, hub_unit_number = hub.unit_number,
	}
	return true, nil
end

function PlatformLineage.ensure(platform)
	local lineage, generation = PlatformLineage.get(platform)
	if lineage then return lineage, generation end
	if storage.source_recovery_ready ~= true or not storage.source_recovery_epoch then
		return nil, "Startup recovery is not ready"
	end
	if not hub_of(platform) then return nil, "Platform has no stable hub identity" end
	local lock = SurfaceLock.get_lock_data(platform.index)
	if lock and (lock.kind == "startup" or lock.kind == "quarantine") then
		return nil, "Platform is protected by startup recovery"
	end
	if SurfaceLock.destination_hold_owns_surface(platform.surface, platform) then
		return nil, "A destination hold owns this platform"
	end
	lineage = PlatformLineage.mint_value(storage.source_recovery_epoch, platform)
	if not lineage then return nil, "Platform lineage is unavailable" end
	local ok, err = PlatformLineage.record(platform, lineage, 0)
	if not ok then return nil, err end
	return lineage, 0
end

function PlatformLineage.for_export(platform, is_transfer)
	local lineage, generation_or_error = PlatformLineage.ensure(platform)
	if lineage then return lineage, generation_or_error end
	if is_transfer then return nil, nil, "Transfer requires a platform lineage: " .. tostring(generation_or_error) end
	return PlatformLineage.get(platform)
end

function PlatformLineage.transfer_carry(data)
	if type(data) ~= "table" or data._standaloneImport == true or not data._transferId then return nil end
	if data._lineage == nil and data._lineageGeneration == nil then return nil end
	if not (PlatformLineage.valid(data._lineage) and PlatformLineage.valid_generation(data._lineageGeneration)) then
		return nil, nil, "Transfer lineage is invalid"
	end
	return data._lineage, data._lineageGeneration
end

function PlatformLineage.presence(lineage)
	if not PlatformLineage.valid(lineage) then return nil, "Invalid platform lineage" end
	for index, record in pairs(storage.surface_export_lineages or {}) do
		if record.lineage == lineage then
			for _, force in pairs(game.forces) do
				local platform = force.platforms[index]
				if platform and platform.valid then
					local current, generation = PlatformLineage.get(platform)
					if current == lineage then return {present = true, generation = generation} end
				end
			end
		end
	end
	for _, hold in pairs(storage.destination_holds or {}) do
		if type(hold) == "table" and hold.lineage == lineage then
			return {present = true, generation = hold.generation, held = true}
		end
	end
	return {present = false}
end

function PlatformLineage.prune(present)
	for index in pairs(storage.surface_export_lineages or {}) do
		if not present[index] then storage.surface_export_lineages[index] = nil end
	end
end

return PlatformLineage
