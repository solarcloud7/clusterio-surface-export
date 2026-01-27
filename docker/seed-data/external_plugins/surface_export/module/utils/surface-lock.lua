-- FactorioSurfaceExport - Surface Locking Utilities
-- Handles locking surfaces during transfer to prevent modifications

local SurfaceLock = {}

-- Entity types that should be deactivated during lock for stable counts
-- MUST match ACTIVATABLE_ENTITY_TYPES in active_state_restoration.lua
local FREEZABLE_ENTITY_TYPES = {
  -- Production
  ["assembling-machine"] = true,
  ["furnace"] = true,
  ["mining-drill"] = true,
  ["lab"] = true,
  ["rocket-silo"] = true,
  ["agricultural-tower"] = true,
  -- Power
  ["reactor"] = true,
  ["generator"] = true,
  ["burner-generator"] = true,
  ["boiler"] = true,
  ["fusion-reactor"] = true,
  ["fusion-generator"] = true,
  -- Logistics - Item transport
  ["inserter"] = true,
  -- Note: Belts cannot be disabled (since Factorio 0.17). This is fine -
  -- with inserters/loaders frozen, no items can enter or leave belts.
  ["loader"] = true,
  ["loader-1x1"] = true,
  -- Logistics - Fluid transport
  ["pump"] = true,
  ["offshore-pump"] = true,
  -- Logistics - Robots
  ["roboport"] = true,
  -- Misc
  ["beacon"] = true,
  ["radar"] = true,
  -- Space platform specific
  ["thruster"] = true,
  ["asteroid-collector"] = true,
  ["cargo-bay"] = true,
  ["space-platform-hub"] = true,  -- Hub controls logistics/construction; may be paused
  -- Planet logistics (for future surface transfers)
  ["cargo-landing-pad"] = true,
}

--- Generate a stable ID for entities without unit_number
--- MUST match EntityScanner.make_stable_id() for frozen_states lookup on import
--- @param entity LuaEntity
--- @return string
local function make_stable_id(entity)
    local position = entity.position or {x = 0, y = 0}
    local orientation_part = entity.orientation and string.format(":%.3f", entity.orientation) or ""
    return string.format("%s@%.3f,%.3f#%s%s",
        entity.name,
        position.x,
        position.y,
        entity.direction or 0,
        orientation_part)
end

--- Freeze all entities on a surface (synchronous - very fast)
--- CRITICAL: This captures the ORIGINAL active state BEFORE freezing.
--- The frozen_states table is included in export data so import can restore
--- entities to their exact pre-export state.
---
--- We only record entity.active - this is the master switch.
--- disabled_by_script is just a status indicator (side effect of active=false).
--- Circuit-driven disabling is dynamic and will be re-evaluated on import.
---
--- @param surface LuaSurface: Surface to freeze
--- @return table, number: Map of entity_id -> original active state, frozen count
local function freeze_entities(surface)
    local original_states = {}
    local frozen_count = 0
    
    local entities = surface.find_entities_filtered({})
    for _, entity in pairs(entities) do
        if entity.valid and FREEZABLE_ENTITY_TYPES[entity.type] then
            -- Use unit_number if available, otherwise generate stable ID
            -- MUST match the entity_id format used in EntityScanner.serialize_entity()
            local unit_id = entity.unit_number or make_stable_id(entity)
            
            -- Check if entity has an active property
            local ok, has_active = pcall(function() return entity.active ~= nil end)
            if ok and has_active then
                -- CRITICAL: Capture the active state BEFORE we freeze
                local was_active = entity.active
                original_states[unit_id] = was_active
                
                -- Freeze the entity
                if was_active then
                    entity.active = false
                    frozen_count = frozen_count + 1
                end
            end
        end
    end
    
    log(string.format("[SurfaceLock] Froze %d entities, captured %d original states", 
        frozen_count, frozen_count))
    return original_states, frozen_count
end

--- Unfreeze entities by restoring original active states
--- @param surface LuaSurface: Surface to unfreeze
--- @param original_states table: Map of entity_id -> original active state (boolean)
--- @return number: Count of entities restored
local function unfreeze_entities(surface, original_states)
    if not original_states or not next(original_states) then
        return 0
    end
    
    local restored_count = 0
    local entities = surface.find_entities_filtered({})
    
    for _, entity in pairs(entities) do
        if entity.valid and FREEZABLE_ENTITY_TYPES[entity.type] then
            local unit_id = entity.unit_number or make_stable_id(entity)
            local was_active = original_states[unit_id]
            
            -- Restore original active state
            if was_active ~= nil then
                local ok = pcall(function() entity.active = was_active end)
                if ok and was_active then
                    restored_count = restored_count + 1
                end
            end
        end
    end
    
    log(string.format("[SurfaceLock] Restored %d entities to active state", restored_count))
    return restored_count
end

--- Activate all freezable entities on a surface
--- Used after successful validation to bring an imported platform to life
--- Sets entity.active = true for all freezable entity types
--- @param surface LuaSurface: Surface to activate
--- @return number: Count of entities activated
function SurfaceLock.activate_all(surface)
    local activated_count = 0
    
    local entities = surface.find_entities_filtered({})
    for _, entity in pairs(entities) do
        if entity.valid and FREEZABLE_ENTITY_TYPES[entity.type] then
            local ok = pcall(function()
                if not entity.active then
                    entity.active = true
                    activated_count = activated_count + 1
                end
            end)
        end
    end
    
    log(string.format("[SurfaceLock] Activated %d entities", activated_count))
    return activated_count
end

--- Complete all in-flight cargo pod transfers immediately
--- Descending pods: Add items to hub inventory, then force finish
--- Ascending pods: Force finish (items are already "sent")
--- @param surface LuaSurface: The platform surface
--- @param hub LuaEntity: The space platform hub
--- @return number, number, number: descending_count, ascending_count, items_recovered
local function complete_cargo_pods(surface, hub)
    local pods = surface.find_entities_filtered({name = "cargo-pod"})
    local descending_count = 0
    local ascending_count = 0
    local items_recovered = 0
    
    for _, pod in ipairs(pods) do
        if pod.valid then
            local state = pod.cargo_pod_state
            
            if state == "descending" or state == "parking" then
                -- Incoming cargo: capture items and add to hub before completing
                local inventory = pod.get_inventory(defines.inventory.cargo_unit)
                if inventory and hub and hub.valid then
                    local hub_inventory = hub.get_inventory(defines.inventory.hub_main)
                    if hub_inventory then
                        for i = 1, #inventory do
                            local stack = inventory[i]
                            if stack.valid_for_read then
                                local inserted = hub_inventory.insert(stack)
                                items_recovered = items_recovered + inserted
                                if inserted < stack.count then
                                    log(string.format("[SurfaceLock] Warning: Could only insert %d/%d of %s", 
                                        inserted, stack.count, stack.name))
                                end
                            end
                        end
                    end
                end
                -- Force immediate completion
                pod.force_finish_descending()
                descending_count = descending_count + 1
                
            elseif state == "ascending" or state == "surface_transition" then
                -- Outgoing cargo: just force complete (items are already "sent")
                pod.force_finish_ascending()
                ascending_count = ascending_count + 1
                
            elseif state == "awaiting_launch" then
                -- Pod waiting to launch - destroy it, items stay in origin
                pod.destroy()
            end
        end
    end
    
    if descending_count > 0 or ascending_count > 0 then
        log(string.format("[SurfaceLock] Completed %d descending pods (recovered %d items), %d ascending pods",
            descending_count, items_recovered, ascending_count))
    end
    
    return descending_count, ascending_count, items_recovered
end

--- Lock a platform surface for transfer
--- Completes cargo pod transfers, freezes entities, hides surface
--- @param platform LuaSpacePlatform: The platform to lock
--- @param force LuaForce: The force that owns the platform
--- @return boolean, string|nil: success, error_message
function SurfaceLock.lock_platform(platform, force)
    if not platform or not platform.valid then
        return false, "Platform not valid"
    end

    local surface = platform.surface
    if not surface or not surface.valid then
        return false, "Platform surface not valid"
    end

    -- Initialize storage
    if not storage.locked_platforms then
        storage.locked_platforms = {}
    end

    -- Check if already locked
    if storage.locked_platforms[platform.name] then
        return false, "Platform already locked"
    end

    -- Store original state
    local original_hidden = force.get_surface_hidden(surface)
    local original_schedule = platform.schedule

    -- Lock the surface (hide from players)
    force.set_surface_hidden(surface, true)

    -- Complete all in-flight cargo pod transfers immediately
    local hub = platform.hub
    local descending, ascending, items = complete_cargo_pods(surface, hub)
    
    if descending > 0 or ascending > 0 then
        game.print(string.format("[Lock] Completed %d incoming (%d items) and %d outgoing cargo pods", 
            descending, items, ascending), {0.5, 1, 0.5})
    end

    -- Freeze all entities (synchronous - very fast)
    local frozen_states, frozen_count = freeze_entities(surface)

    -- Store lock data
    storage.locked_platforms[platform.name] = {
        platform_name = platform.name,
        platform_index = platform.index,
        surface_index = surface.index,
        force_name = force.name,
        original_hidden = original_hidden,
        original_schedule = original_schedule,
        locked_tick = game.tick,
        frozen_states = frozen_states,
        frozen_count = frozen_count,
    }

    log(string.format("[SurfaceLock] Locked platform '%s' (index %d), froze %d entities", 
        platform.name, platform.index, frozen_count))

    return true, nil
end

--- Unlock a platform surface (restore original state and unfreeze entities)
--- @param platform_name string: Name of the platform to unlock
--- @return boolean, string|nil: success, error_message
function SurfaceLock.unlock_platform(platform_name)
    if not storage.locked_platforms then
        return false, "No locked platforms"
    end

    local lock_data = storage.locked_platforms[platform_name]
    if not lock_data then
        return false, "Platform not locked: " .. platform_name
    end

    -- Find the platform
    local force = game.forces[lock_data.force_name]
    if not force then
        storage.locked_platforms[platform_name] = nil
        return false, "Force not found: " .. lock_data.force_name
    end

    local platform = force.platforms[lock_data.platform_index]
    if not platform or not platform.valid then
        storage.locked_platforms[platform_name] = nil
        return false, "Platform no longer exists"
    end

    local surface = platform.surface
    local restored = 0
    if surface and surface.valid then
        -- Restore entity active states
        restored = unfreeze_entities(surface, lock_data.frozen_states)
        
        -- Restore original visibility
        force.set_surface_hidden(surface, lock_data.original_hidden)

        -- Restore original schedule if it existed
        if lock_data.original_schedule then
            platform.schedule = lock_data.original_schedule
        end
    end

    -- Remove lock data
    storage.locked_platforms[platform_name] = nil

    log(string.format("[SurfaceLock] Unlocked platform '%s', restored %d entities", platform_name, restored))
    game.print(string.format("[Lock] Platform '%s' unlocked and restored", platform_name), {0.5, 1, 0.5})

    return true, nil
end

--- Check if a platform is locked
--- @param platform_name string: Name of the platform
--- @return boolean: true if locked
function SurfaceLock.is_locked(platform_name)
    if not storage.locked_platforms then
        return false
    end
    return storage.locked_platforms[platform_name] ~= nil
end

--- Get lock data for a platform
--- @param platform_name string: Name of the platform
--- @return table|nil: Lock data or nil if not locked
function SurfaceLock.get_lock_data(platform_name)
    if not storage.locked_platforms then
        return nil
    end
    return storage.locked_platforms[platform_name]
end

--- Clean up stale locks (platforms that no longer exist or are too old)
--- @param max_age_ticks number: Maximum age in ticks before considering a lock stale
function SurfaceLock.cleanup_stale_locks(max_age_ticks)
    if not storage.locked_platforms then
        return
    end

    max_age_ticks = max_age_ticks or 36000  -- Default: 10 minutes at 60 UPS

    for platform_name, lock_data in pairs(storage.locked_platforms) do
        local age = game.tick - lock_data.locked_tick

        -- Check if platform still exists
        local force = game.forces[lock_data.force_name]
        local platform_exists = false

        if force then
            local platform = force.platforms[lock_data.platform_index]
            if platform and platform.valid and platform.name == platform_name then
                platform_exists = true
            end
        end

        -- Remove stale lock
        if not platform_exists or age > max_age_ticks then
            log(string.format("[SurfaceLock] Removing stale lock: %s (age: %d ticks, exists: %s)",
                platform_name, age, tostring(platform_exists)))
            SurfaceLock.unlock_platform(platform_name)
        end
    end
end

return SurfaceLock
