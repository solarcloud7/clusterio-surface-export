local GameUtils = require("modules/surface_export/utils/game-utils")
local PlatformSchedule = require("modules/surface_export/utils/platform-schedule")

local SurfaceLock = {}

local ACTIVATABLE_ENTITY_TYPES = GameUtils.ACTIVATABLE_ENTITY_TYPES
local DEFAULT_TRANSFER_LOCK_TTL_TICKS = 36000
local VALIDATION_TIMEOUT_TICKS     = 7200
local WORST_CASE_RCON_TICKS        = 3000
local WORST_CASE_SCAN_IMPORT_TICKS = 6000
local WORST_CASE_MARGIN_TICKS      = 3000
local MIN_WORST_CASE_TRANSFER_TTL_TICKS =
    VALIDATION_TIMEOUT_TICKS + WORST_CASE_RCON_TICKS + WORST_CASE_SCAN_IMPORT_TICKS + WORST_CASE_MARGIN_TICKS
SurfaceLock.DEFAULT_TRANSFER_LOCK_TTL_TICKS = DEFAULT_TRANSFER_LOCK_TTL_TICKS
SurfaceLock.MIN_WORST_CASE_TRANSFER_TTL_TICKS = MIN_WORST_CASE_TRANSFER_TTL_TICKS
local SOURCE_TRANSFER_PHASE_PRE_COMMIT = "pre_commit"
local SOURCE_TRANSFER_PHASE_COMMITTED = "committed"
local COMMITTED_SOURCE_TOMBSTONE_RETENTION_TICKS = DEFAULT_TRANSFER_LOCK_TTL_TICKS + WORST_CASE_MARGIN_TICKS
SurfaceLock.SOURCE_TRANSFER_PHASE_PRE_COMMIT = SOURCE_TRANSFER_PHASE_PRE_COMMIT
SurfaceLock.SOURCE_TRANSFER_PHASE_COMMITTED = SOURCE_TRANSFER_PHASE_COMMITTED
SurfaceLock.COMMITTED_SOURCE_TOMBSTONE_RETENTION_TICKS = COMMITTED_SOURCE_TOMBSTONE_RETENTION_TICKS
local EXPIRABLE_LOCK_KINDS = { transfer = true, export = true }

local function freeze_entities(surface)
    local original_states = {}
    local frozen_count = 0
    
    local captured_count = 0
    local entities = surface.find_entities_filtered({})
    for _, entity in pairs(entities) do
        if entity.valid then
            local activatable = ACTIVATABLE_ENTITY_TYPES[entity.type]
            local ok, has_active = pcall(function() return entity.active ~= nil end)
            if not ok then
                if activatable then
                    log(string.format("[SurfaceLock] freeze: reading entity.active failed for '%s': %s",
                        tostring(entity.name), tostring(has_active)))
                end
            elseif has_active then
                local was_active = entity.active
                if activatable then
                    original_states[entity.unit_number or GameUtils.make_stable_id(entity)] = was_active
                    captured_count = captured_count + 1
                    if was_active then
                        entity.disabled_by_script = true
                        frozen_count = frozen_count + 1
                    end
                elseif was_active == false then
                    original_states[entity.unit_number or GameUtils.make_stable_id(entity)] = false
                    captured_count = captured_count + 1
                end
            end
        end
    end

    log(string.format("[SurfaceLock] Froze %d entities, captured %d original states",
        frozen_count, captured_count))
    return original_states, frozen_count
end

local function unfreeze_entities(surface, original_states)
    if not original_states or not next(original_states) then
        return 0
    end
    
    local restored_count = 0
    local entities = surface.find_entities_filtered({})
    
    for _, entity in pairs(entities) do
        if entity.valid and ACTIVATABLE_ENTITY_TYPES[entity.type] then
            local unit_id = entity.unit_number or GameUtils.make_stable_id(entity)
            local was_active = original_states[unit_id]
            
            if was_active ~= nil then
                local ok, err = pcall(function() entity.disabled_by_script = not was_active end)
                if not ok then
                    log(string.format("[SurfaceLock] unfreeze: restoring entity.active failed for '%s': %s",
                        tostring(entity.name), tostring(err)))
                elseif was_active then
                    restored_count = restored_count + 1
                end
            end
        end
    end
    
    log(string.format("[SurfaceLock] Restored %d entities to active state", restored_count))
    return restored_count
end

function SurfaceLock.activate_all(surface)
    local activated_count = 0
    
    local entities = surface.find_entities_filtered({})
    for _, entity in pairs(entities) do
        if entity.valid and ACTIVATABLE_ENTITY_TYPES[entity.type] then
            GameUtils.pcall_warn("[SurfaceLock] activate_all: activating entity '" .. tostring(entity.name) .. "'", function()
                if not entity.active then
                    entity.disabled_by_script = false
                    activated_count = activated_count + 1
                end
            end)
        end
    end
    
    log(string.format("[SurfaceLock] Activated %d entities", activated_count))
    return activated_count
end

local function recover_pod_cargo_to_hub_and_spill(pod, hub, surface)
    local inventory = pod.get_inventory(defines.inventory.cargo_unit)
    if not inventory then return 0 end
    local hub_inventory = (hub and hub.valid) and hub.get_inventory(defines.inventory.hub_main) or nil
    local preserved = 0
    for i = 1, #inventory do
        local stack = inventory[i]
        if stack.valid_for_read then
            local stack_name = stack.name
            local stack_count = stack.count
            local stack_quality = stack.quality and stack.quality.name or nil
            local inserted = hub_inventory and hub_inventory.insert(stack) or 0
            preserved = preserved + inserted
            local remainder = stack_count - inserted
            if inserted > 0 then
                if remainder > 0 then
                    stack.count = remainder
                else
                    stack.clear()
                end
            end
            if remainder > 0 then
                local spill_ok, spill_err = pcall(function()
                    surface.spill_item_stack({
                        position = pod.position,
                        stack = { name = stack_name, count = remainder, quality = stack_quality },
                    })
                end)
                if spill_ok then
                    preserved = preserved + remainder
                    stack.clear()
                else
                    log(string.format("[SurfaceLock] cargo recovery spill failed for %d %s: %s",
                        remainder, tostring(stack_name), tostring(spill_err)))
                end
            end
        end
    end
    return preserved
end

local function complete_cargo_pods(surface, hub)
    local pods = surface.find_entities_filtered({name = "cargo-pod"})
    local descending_count = 0
    local ascending_count = 0
    local items_recovered = 0
    
    for _, pod in ipairs(pods) do
        if pod.valid then
            local state = pod.cargo_pod_state
            
            if state == "descending" or state == "parking" then
                items_recovered = items_recovered + recover_pod_cargo_to_hub_and_spill(pod, hub, surface)
                pod.destroy()
                descending_count = descending_count + 1

            elseif state == "ascending" or state == "surface_transition" then
                pod.force_finish_ascending()
                ascending_count = ascending_count + 1
                
            elseif state == "awaiting_launch" then
                items_recovered = items_recovered + recover_pod_cargo_to_hub_and_spill(pod, hub, surface)
                pod.destroy()
            end
        end
    end
    
    if descending_count > 0 or ascending_count > 0 or items_recovered > 0 then
        log(string.format("[SurfaceLock] Completed %d descending pods (recovered %d items), %d ascending pods",
            descending_count, items_recovered, ascending_count))
    end
    
    return descending_count, ascending_count, items_recovered
end
SurfaceLock.complete_cargo_pods = complete_cargo_pods

function SurfaceLock.ensure_index_keyed()
    local locks = storage.locked_platforms
    if type(locks) ~= "table" then return 0, 0 end
    local has_string_key = false
    for k, _ in pairs(locks) do
        if type(k) == "string" then has_string_key = true; break end
    end
    if not has_string_key then return 0, 0 end

    local rekeyed, moved, dropped = {}, 0, 0
    for key, lock_data in pairs(locks) do
        if type(key) == "number" then
            rekeyed[key] = lock_data
        elseif type(lock_data) == "table" and type(lock_data.platform_index) == "number" then
            rekeyed[lock_data.platform_index] = lock_data
            moved = moved + 1
        else
            dropped = dropped + 1
        end
    end
    storage.locked_platforms = rekeyed
    log(string.format("[SurfaceLock] Migrated lock registry to index keys: %d re-keyed, %d dropped (no index)", moved, dropped))
    return moved, dropped
end

function SurfaceLock.is_same_transfer_upgrade(existing_job_id, opts_job_id)
    return existing_job_id == nil or existing_job_id == opts_job_id
end

function SurfaceLock.source_lock_initial_phase(lock_opts)
    if lock_opts and lock_opts.kind == "transfer" then
        return SOURCE_TRANSFER_PHASE_PRE_COMMIT
    end
    return nil
end

function SurfaceLock.source_lock_phase(lock)
    if type(lock) ~= "table" then return nil end
    if lock.kind ~= "transfer" then return lock.phase end
    if lock.phase == nil then
        return SOURCE_TRANSFER_PHASE_PRE_COMMIT
    end
    return lock.phase
end

function SurfaceLock.source_lock_is_committed(lock)
    return SurfaceLock.source_lock_phase(lock) == SOURCE_TRANSFER_PHASE_COMMITTED
end

local function committed_source_tombstones()
    if type(storage.committed_source_transfer_tombstones) ~= "table" then
        storage.committed_source_transfer_tombstones = {}
    end
    return storage.committed_source_transfer_tombstones
end

function SurfaceLock.prune_committed_source_tombstones(now_tick)
    local tombstones = storage.committed_source_transfer_tombstones
    if type(tombstones) ~= "table" then return 0 end
    local now = now_tick or game.tick
    local pruned = 0
    for transfer_id, tombstone in pairs(tombstones) do
        local committed_tick = type(tombstone) == "table" and tonumber(tombstone.committed_tick) or nil
        if not committed_tick or now - committed_tick > COMMITTED_SOURCE_TOMBSTONE_RETENTION_TICKS then
            tombstones[transfer_id] = nil
            pruned = pruned + 1
        end
    end
    return pruned
end

local function record_committed_source_tombstone(lock, transfer_id)
    local canonical_id = transfer_id or lock.committed_transfer_id or lock.transfer_job_id
    if not canonical_id then return nil end
    local tombstones = committed_source_tombstones()
    local existing = tombstones[canonical_id] or {}
    existing.transfer_id = canonical_id
    existing.platform_index = lock.platform_index
    existing.platform_name = lock.platform_name
    existing.force_name = lock.force_name
    existing.surface_index = lock.surface_index
    existing.transfer_job_id = lock.transfer_job_id
    existing.committed_tick = existing.committed_tick or game.tick
    existing.source_deleted_tick = existing.source_deleted_tick
    tombstones[canonical_id] = existing
    return existing
end

function SurfaceLock.commit_source_transfer_lock(platform_index, transfer_id)
    if not storage.locked_platforms then return false, "No locked platforms" end
    local lock = storage.locked_platforms[platform_index]
    if not lock or lock.kind ~= "transfer" then
        return false, "source is not locked-for-transfer"
    end
    if transfer_id and lock.transfer_job_id and lock.transfer_job_id ~= transfer_id then
        return false, "lock belongs to a different transfer"
    end
    lock.phase = SOURCE_TRANSFER_PHASE_COMMITTED
    lock.committed_transfer_id = transfer_id or lock.committed_transfer_id or lock.transfer_job_id
    lock.committed_tick = lock.committed_tick or game.tick
    record_committed_source_tombstone(lock, lock.committed_transfer_id)
    SurfaceLock.prune_committed_source_tombstones(game.tick)
    return true, nil
end

function SurfaceLock.clear_committed_source_lock_after_delete(platform_index, transfer_id)
    if not storage.locked_platforms then return false, "No locked platforms" end
    local lock = storage.locked_platforms[platform_index]
    if not SurfaceLock.source_lock_is_committed(lock) then
        return false, "source lock is not committed"
    end
    if transfer_id and lock.committed_transfer_id and lock.committed_transfer_id ~= transfer_id then
        return false, "committed lock belongs to a different transfer"
    end
    local canonical_id = transfer_id or lock.committed_transfer_id or lock.transfer_job_id
    local tombstones = storage.committed_source_transfer_tombstones
    local tombstone = type(tombstones) == "table" and canonical_id and tombstones[canonical_id] or nil
    if type(tombstone) ~= "table" then
        return false, "committed source tombstone missing for " .. tostring(canonical_id)
    end
    tombstone.source_deleted_tick = game.tick
    storage.locked_platforms[platform_index] = nil
    return true, nil
end

function SurfaceLock.get_source_transfer_lock_state(transfer_id, platform_index, platform_name, force_name)
    SurfaceLock.prune_committed_source_tombstones(game.tick)
    local tombstones = storage.committed_source_transfer_tombstones
    local tombstone = type(tombstones) == "table" and transfer_id and tombstones[transfer_id] or nil
    if type(tombstone) == "table" and tombstone.source_deleted_tick then
        return { state = "source_gone_matching_transfer", transferId = transfer_id, error = nil }
    end

    local lock = storage.locked_platforms and storage.locked_platforms[platform_index] or nil
    if type(lock) == "table" then
        if force_name and lock.force_name and lock.force_name ~= force_name then
            return { state = "identity_mismatch", transferId = transfer_id, error = "force mismatch" }
        end
        if transfer_id and lock.transfer_job_id and lock.transfer_job_id ~= transfer_id and lock.committed_transfer_id ~= transfer_id then
            return { state = "identity_mismatch", transferId = transfer_id, error = "transfer id mismatch" }
        end
        if SurfaceLock.source_lock_is_committed(lock) then
            return { state = "committed", transferId = transfer_id, error = nil }
        end
        if SurfaceLock.source_lock_phase(lock) == SOURCE_TRANSFER_PHASE_PRE_COMMIT then
            return { state = "pre_commit", transferId = transfer_id, error = nil }
        end
    end

    local force = force_name and game.forces[force_name] or nil
    local platform = force and force.platforms and force.platforms[platform_index] or nil
    if platform and platform.valid then
        return { state = "identity_mismatch", transferId = transfer_id, error = "source platform is live or not locked" }
    end
    return { state = "identity_mismatch", transferId = transfer_id, error = "no matching source lock or tombstone" }
end
function SurfaceLock.destination_hold_owns_surface(surface, platform)
    local holds = storage.destination_holds
    if type(holds) ~= "table" or not (surface and surface.valid and platform and platform.valid) then
        return false, nil
    end
    for transfer_id, hold in pairs(holds) do
        if type(hold) == "table"
            and hold.surface_index == surface.index
            and hold.platform_index == platform.index then
            return true, transfer_id
        end
    end
    return false, nil
end

function SurfaceLock.lock_platform(platform, force, lock_opts)
    if not platform or not platform.valid then
        return false, "Platform not valid"
    end

    local surface = platform.surface
    if not surface or not surface.valid then
        return false, "Platform surface not valid"
    end

    if not storage.locked_platforms then
        storage.locked_platforms = {}
    end
    SurfaceLock.ensure_index_keyed()

    local existing_lock = storage.locked_platforms[platform.index]
    if existing_lock then
        if lock_opts and lock_opts.kind == "transfer" and existing_lock.kind == "transfer"
            and existing_lock.surface_index == surface.index then
            if not SurfaceLock.is_same_transfer_upgrade(existing_lock.transfer_job_id, lock_opts.job_id) then
                return false, "Platform already locked by a different in-flight transfer"
            end
            existing_lock.transfer_job_id = lock_opts.job_id or existing_lock.transfer_job_id
            existing_lock.phase = existing_lock.phase or SurfaceLock.source_lock_initial_phase(lock_opts)
            existing_lock.expires_tick = lock_opts.expires_tick or existing_lock.expires_tick
            return true, nil
        end
        if lock_opts and lock_opts.kind == "transfer" and existing_lock.kind == "transfer" then
            return false, "Platform already locked by a different transfer lock"
        end
        if lock_opts and lock_opts.kind == "transfer" and existing_lock.kind ~= "transfer" then
            return false, "Platform already locked by a non-transfer lock"
        end
        return false, "Platform already locked"
    end

    local original_hidden = force.get_surface_hidden(surface)
    local original_schedule, schedule_err = PlatformSchedule.capture(platform, platform.hub)
    if not original_schedule then
        return false, "Failed to capture original platform schedule: " .. tostring(schedule_err)
    end

    force.set_surface_hidden(surface, true)

    local hub = platform.hub
    local descending, ascending, items = complete_cargo_pods(surface, hub)
    
    if descending > 0 or ascending > 0 then
        game.print(string.format("[Lock] Completed %d incoming (%d items) and %d outgoing cargo pods", 
            descending, items, ascending), {0.5, 1, 0.5})
    end

    local frozen_states, frozen_count = freeze_entities(surface)

    storage.locked_platforms[platform.index] = {
        platform_name = platform.name,
        platform_index = platform.index,
        surface_index = surface.index,
        force_name = force.name,
        original_hidden = original_hidden,
        original_schedule = original_schedule,
        locked_tick = game.tick,
        kind = lock_opts and lock_opts.kind or nil,
        phase = SurfaceLock.source_lock_initial_phase(lock_opts),
        transfer_job_id = lock_opts and lock_opts.job_id or nil,
        expires_tick = lock_opts and lock_opts.expires_tick or nil,
        frozen_states = frozen_states,
        frozen_count = frozen_count,
    }

    log(string.format("[SurfaceLock] Locked platform '%s' (index %d), froze %d entities", 
        platform.name, platform.index, frozen_count))

    return true, nil
end

function SurfaceLock.unlock_platform(platform_index, expected_name)
    if not storage.locked_platforms then
        return false, "No locked platforms"
    end

    local lock_data = storage.locked_platforms[platform_index]
    if not lock_data then
        return false, "Platform not locked: index " .. tostring(platform_index)
    end
    local platform_name = lock_data.platform_name
    if expected_name ~= nil and platform_name ~= expected_name then -- lint-lua:allow compares STORED snapshots (lock_data name vs caller expectation), not the live platform.name — not rename-vulnerable; surface.index is the primary identity at the tripwire below. Collision-residual follow-up: pass expected_surface_index.
        return false, string.format("Unlock refused: index %s is locked for a DIFFERENT platform (expected '%s', locked '%s')",
            tostring(platform_index), tostring(expected_name), tostring(platform_name))
    end

    if SurfaceLock.source_lock_is_committed(lock_data) then
        return false, string.format("Unlock refused: committed transfer lock for '%s' (index %s) is a non-live source tombstone; only delete_platform_for_transfer may clear it",
            tostring(platform_name), tostring(platform_index))
    end
    local force = game.forces[lock_data.force_name]
    if not force then
        storage.locked_platforms[platform_index] = nil
        return false, "Force not found: " .. tostring(lock_data.force_name)
    end

    local platform = force.platforms[lock_data.platform_index]
    if not platform or not platform.valid then
        storage.locked_platforms[platform_index] = nil
        return false, "Platform no longer exists"
    end

    local surface = platform.surface
    if not (surface and surface.valid and surface.index == lock_data.surface_index) then
        storage.locked_platforms[platform_index] = nil
        log(string.format("[SurfaceLock] unlock: index %s now holds a different surface (locked %s, found %s) — dropping stale lock WITHOUT restoring",
            tostring(platform_index), tostring(lock_data.surface_index), tostring(surface and surface.index)))
        return false, "Platform index reused since lock — stale lock dropped (not restored)"
    end

    local destination_hold_active, destination_hold_transfer_id = SurfaceLock.destination_hold_owns_surface(surface, platform)
    if destination_hold_active then
        storage.locked_platforms[platform_index] = nil
        log(string.format("[SurfaceLock] unlock: destination hold %s owns platform '%s' (index %s, surface %s); not restoring hold-owned not-live state",
            tostring(destination_hold_transfer_id), tostring(platform_name), tostring(platform_index), tostring(surface.index)))
        game.print(string.format("[Lock] Platform '%s' lock released; destination hold remains in control", tostring(platform_name)), {0.5, 1, 0.5})
        return true, nil
    end

    local restored = unfreeze_entities(surface, lock_data.frozen_states)
    force.set_surface_hidden(surface, lock_data.original_hidden)
    if lock_data.original_schedule then
        local schedule_restore_ok, schedule_restore_err = PlatformSchedule.apply(platform, lock_data.original_schedule)
        if not schedule_restore_ok then
            storage.locked_platforms[platform_index] = nil
            return false, "Failed to restore original platform schedule: " .. tostring(schedule_restore_err)
        end
    end

    storage.locked_platforms[platform_index] = nil

    log(string.format("[SurfaceLock] Unlocked platform '%s' (index %s), restored %d entities",
        tostring(platform_name), tostring(platform_index), restored))
    game.print(string.format("[Lock] Platform '%s' unlocked and restored", tostring(platform_name)), {0.5, 1, 0.5})

    return true, nil
end

function SurfaceLock.is_locked(platform_index)
    if not storage.locked_platforms then
        return false
    end
    return storage.locked_platforms[platform_index] ~= nil
end

function SurfaceLock.get_lock_data(platform_index)
    if not storage.locked_platforms then
        return nil
    end
    return storage.locked_platforms[platform_index]
end

function SurfaceLock.transfer_delete_identity_ok(lock, current_surface, expected_job_id)
    if not lock or lock.kind ~= "transfer" then
        return false, "source is not locked-for-transfer (released by TTL/admin, or never locked)"
    end
    if expected_job_id and lock.transfer_job_id and lock.transfer_job_id ~= expected_job_id then
        return false, string.format("lock belongs to a different transfer (job_id '%s' != requested '%s')",
            tostring(lock.transfer_job_id), tostring(expected_job_id))
    end
    if not (current_surface and current_surface.valid and current_surface.index == lock.surface_index) then
        return false, "surface identity mismatch (index reused since lock?)"
    end
    return true, nil
end

function SurfaceLock.find_lock_key_by_name(platform_name)
    if not storage.locked_platforms then
        return nil
    end
    local found, count = nil, 0
    for idx, lock_data in pairs(storage.locked_platforms) do
        if lock_data.platform_name == platform_name then -- lint-lua:allow sanctioned name→index resolver at the ADMIN tooling boundary (fails loud on ambiguity below) — the owner-approved exception to "identity = surface.index"
            found = idx
            count = count + 1
        end
    end
    if count > 1 then
        return nil, "ambiguous: " .. count .. " locked platforms named '" .. tostring(platform_name) .. "' — unlock by index"
    end
    return found, nil
end

function SurfaceLock.scan_transfer_expiries()
    if not storage.locked_platforms then
        return { checked = 0, expired = 0, skipped = 0, failed = 0, committed = 0 }
    end

    local checked, expired, skipped, failed, committed = 0, 0, 0, 0, 0

    for platform_index, lock_data in pairs(storage.locked_platforms) do
        if type(lock_data) == "table" and EXPIRABLE_LOCK_KINDS[lock_data.kind] then
            checked = checked + 1
            if SurfaceLock.source_lock_is_committed(lock_data) then
                committed = committed + 1
                skipped = skipped + 1
            else
                local locked_tick = lock_data.locked_tick
                if not locked_tick then
                    skipped = skipped + 1
                else
                    local expires_tick = lock_data.expires_tick or (locked_tick + DEFAULT_TRANSFER_LOCK_TTL_TICKS)
                    if game.tick >= expires_tick then
                        log(string.format("[SurfaceLock] Transfer lock expired: '%s' (index %s, locked_tick=%s, expires_tick=%s)",
                            tostring(lock_data.platform_name), tostring(platform_index), tostring(locked_tick), tostring(expires_tick)))
                        local ok, err = SurfaceLock.unlock_platform(platform_index, lock_data.platform_name)
                        if ok then
                            expired = expired + 1
                        else
                            failed = failed + 1
                            log(string.format("[SurfaceLock] Transfer-lock expiry UNLOCK FAILED for '%s' (index %s): %s",
                                tostring(lock_data.platform_name), tostring(platform_index), tostring(err)))
                        end
                    end
                end
            end
        end
    end

    SurfaceLock.prune_committed_source_tombstones(game.tick)
    return { checked = checked, expired = expired, skipped = skipped, failed = failed, committed = committed }
end

return SurfaceLock
