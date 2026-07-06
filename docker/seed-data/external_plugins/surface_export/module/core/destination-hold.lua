-- Destination hold primitive for Phase-2 transfer staging.
--
-- This module is intentionally not wired into the normal transfer path yet. Phase 2 first needs a live-proven
-- primitive that can hold a fully-finalized destination copy in a non-live state, then release or discard it by
-- canonical transfer id.

local GameUtils = require("modules/surface_export/utils/game-utils")

local DestinationHold = {}

local function ensure_storage()
	storage.destination_holds = storage.destination_holds or {}
	return storage.destination_holds
end

local function entity_key(entity)
	if entity.unit_number then return tostring(entity.unit_number) end
	return GameUtils.make_stable_id(entity)
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
				entity.active = false
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
					entity.active = true
					restored = restored + 1
				end
			else
				if entity.active then
					entity.active = false
				end
				kept_inactive = kept_inactive + 1
			end
		end
	end
	return restored, kept_inactive
end

local function resolve_hold(transfer_id)
	local holds = ensure_storage()
	local hold = holds[transfer_id]
	if not hold then
		return nil, nil, nil, "No destination hold for transfer_id " .. tostring(transfer_id)
	end
	local force = game.forces[hold.force_name]
	local platform = find_platform(force, hold.platform_index)
	if not (platform and platform.valid) then
		return hold, force, nil, "Held platform is missing"
	end
	local surface = platform.surface
	if not (surface and surface.valid and surface.index == hold.surface_index) then
		return hold, force, platform, "Held platform surface changed or is missing"
	end
	return hold, force, platform, nil
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

--- Stage a destination platform in a non-live hold.
--- @param transfer_id string
--- @param platform LuaSpacePlatform
--- @param force LuaForce
--- @return boolean, string|table
function DestinationHold.stage(transfer_id, platform, force)
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
	local existing = holds[transfer_id]
	if existing then
		if existing.surface_index == surface.index and existing.platform_index == platform.index then
			return true, existing
		end
		return false, "transfer_id already holds a different destination platform"
	end
	local other_transfer_id = find_hold_for_platform(holds, surface.index, platform.index, transfer_id)
	if other_transfer_id then
		return false, "platform is already held by transfer_id " .. tostring(other_transfer_id)
	end

	local original_hidden = force.get_surface_hidden(surface)
	local original_paused = platform.paused == true
	local active_states = {}
	local deactivated = 0
	local staged_ok, staged_err = pcall(function()
		platform.paused = true
		force.set_surface_hidden(surface, true)
		deactivated = capture_and_deactivate(surface, active_states)
	end)
	if not staged_ok then
		log(string.format("[DestinationHold] stage failed for transfer %s on platform '%s': %s",
			transfer_id, platform.name, tostring(staged_err)))
		local restore_ok, restore_err = pcall(function()
			restore_active_states(surface, active_states)
			force.set_surface_hidden(surface, original_hidden == true)
			platform.paused = original_paused == true
		end)
		if not restore_ok then
			log(string.format("[DestinationHold] stage rollback failed for transfer %s on platform '%s': %s",
				transfer_id, platform.name, tostring(restore_err)))
		end
		return false, "Failed to stage destination hold: " .. tostring(staged_err)
	end

	local hold = {
		transfer_id = transfer_id,
		force_name = force.name,
		platform_index = platform.index,
		platform_name = platform.name,
		surface_index = surface.index,
		original_hidden = original_hidden,
		original_paused = original_paused,
		active_states = active_states,
		deactivated_count = deactivated,
		held_tick = game.tick,
	}
	holds[transfer_id] = hold
	log(string.format("[DestinationHold] staged transfer %s on platform '%s' (idx=%s, surface=%s, deactivated=%d)",
		transfer_id, platform.name, tostring(platform.index), tostring(surface.index), deactivated))
	return true, hold
end

--- Release a held destination platform to live.
--- @param transfer_id string
--- @return boolean, string|table
function DestinationHold.go_live(transfer_id)
	local holds = ensure_storage()
	local hold, force, platform, err = resolve_hold(transfer_id)
	if err then return false, err end
	local surface = platform.surface
	local restored, kept_inactive = restore_active_states(surface, hold.active_states)
	force.set_surface_hidden(surface, hold.original_hidden == true)
	platform.paused = hold.original_paused == true
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

--- Discard a held destination platform.
--- @param transfer_id string
--- @return boolean, string|table
function DestinationHold.discard(transfer_id)
	local holds = ensure_storage()
	local hold, _, platform, err = resolve_hold(transfer_id)
	if err then
		if err == "Held platform is missing" or err == "Held platform surface changed or is missing" then
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
				surface_changed = (err == "Held platform surface changed or is missing"),
			}
		end
		return false, err
	end
	local deleted = GameUtils.delete_platform(platform)
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

--- Return the persisted hold state, or nil if not staged.
--- @param transfer_id string
--- @return table|nil
function DestinationHold.get(transfer_id)
	return ensure_storage()[transfer_id]
end

return DestinationHold
