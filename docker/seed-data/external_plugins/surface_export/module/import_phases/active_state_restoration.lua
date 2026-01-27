-- FactorioSurfaceExport - Active State Restoration Phase
-- Final import step: Restore entities to their original active state
--
-- This is the "Wake Up" signal - the LAST phase of import.
-- By this point, all geometry is placed, fluids/belts are hydrated,
-- and circuit wires are connected. Entities wake up to a "ready" environment.

local ActiveStateRestoration = {}

-- Entity types that can be deactivated (matches surface-lock.lua FREEZABLE_ENTITY_TYPES)
local ACTIVATABLE_ENTITY_TYPES = {
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

--- Restore all entities to their original active state
--- This is the FINAL step of import, after all entities are created and configured.
---
--- We only restore entity.active - this is the master switch.
--- disabled_by_script is just a status indicator (side effect of active=false).
--- Circuit-driven disabling is dynamic and will be re-evaluated automatically.
---
--- @param entities_to_create table: List of entity data objects
--- @param entity_map table: Map of entity_id to LuaEntity
--- @param frozen_states table: Map of original_entity_id to original active state (boolean)
function ActiveStateRestoration.restore(entities_to_create, entity_map, frozen_states)
    log("[Import] Restoring original active states (final step)...")
    frozen_states = frozen_states or {}
    
    local activated_count = 0
    local kept_inactive_count = 0
    local skipped_count = 0
    
    for _, entity_data in ipairs(entities_to_create) do
        local entity = entity_map[entity_data.entity_id]
        
        -- Skip if no entity
        if not entity or not entity.valid then
            goto continue
        end
        
        -- Only process entity types that can be activated/deactivated
        if not ACTIVATABLE_ENTITY_TYPES[entity.type] then
            goto continue
        end
        
        -- Look up the ORIGINAL active state from frozen_states
        -- The entity_id in entity_data is the ORIGINAL unit_number from export
        local was_active = frozen_states[entity_data.entity_id]
        
        -- If not in frozen_states, default to active (most entities are active)
        if was_active == nil then
            was_active = true
        end
        
        -- Restore the original active state
        -- Note: pcall removed for performance - we filter by ACTIVATABLE_ENTITY_TYPES
        -- so entity.active is guaranteed to exist. If a modded entity causes issues,
        -- add error handling back or exclude that entity type.
        if was_active then
            -- Entity was active before export - re-enable it
            if not entity.active then
                entity.active = true
                activated_count = activated_count + 1
            end
        else
            -- Entity was inactive before export - keep it inactive
            if entity.active then
                entity.active = false
            end
            kept_inactive_count = kept_inactive_count + 1
        end
        
        ::continue::
    end
    
    log(string.format("[Import] Active state restoration complete: %d activated, %d kept inactive, %d skipped",
        activated_count, kept_inactive_count, skipped_count))    
    
    if activated_count > 0 then
        game.print(string.format("[Import] Activated %d entities (restored to original state)", activated_count), {0, 1, 0})
    end
end

return ActiveStateRestoration
