local Deserializer = require("modules/surface_export/core/deserializer")
local EntityStateRestoration = {}

--- Restore entity state, filters, and connections
--- @param entities_to_create table: List of entity data objects
--- @param entity_map table: Map of entity_id to LuaEntity
--- @return table: Metrics about restoration
function EntityStateRestoration.restore_all(entities_to_create, entity_map)
    local circuits_connected = 0
    local power_connected = 0
    
    -- Step 1: Restore control behavior (circuit conditions, combinator signals)
    log("[Import] Restoring control behavior...")
    for _, entity_data in ipairs(entities_to_create) do
      local entity = entity_map[entity_data.entity_id]
      if entity and entity.valid then
        Deserializer.restore_control_behavior(entity, entity_data)
      end
    end
    
    -- NOTE: mining_progress is deliberately NOT restored here. A pre-binding write is unanchored
    -- (LuaControl: the value's range is defined by mining_target, nil until the drill's first
    -- update) — it rides the deferred queue in active_state_restoration.lua instead, which writes
    -- once the target binds. An abandoned same-execution pass lived here 2026-07-28/29; deleted
    -- with the mechanism resolved (review must-fix 3).

    -- Step 2: Restore entity filters (inserter filters, loader filters)
    log("[Import] Restoring entity filters...")
    for _, entity_data in ipairs(entities_to_create) do
      local entity = entity_map[entity_data.entity_id]
      if entity and entity.valid then
        Deserializer.restore_entity_filters(entity, entity_data)
      end
    end
    
    -- Step 3: Restore logistic requests
    log("[Import] Restoring logistic requests...")
    for _, entity_data in ipairs(entities_to_create) do
      local entity = entity_map[entity_data.entity_id]
      if entity and entity.valid then
        Deserializer.restore_logistic_requests(entity, entity_data)
      end
    end

    -- Step 3b: Restore MANUAL logistic sections (2.0 sections API). The hub is in entity_map
    -- (PlatformHubMapping), so the platform's pending item requests are restored here too.
    log("[Import] Restoring logistic sections...")
    for _, entity_data in ipairs(entities_to_create) do
      local entity = entity_map[entity_data.entity_id]
      if entity and entity.valid then
        Deserializer.restore_logistic_sections(entity, entity_data)
      end
    end

    -- Step 4: Restore circuit connections (red/green wires)
    log("[Import] Restoring circuit connections...")
    for _, entity_data in ipairs(entities_to_create) do
      local entity = entity_map[entity_data.entity_id]
      if entity and entity.valid then
        local connected = Deserializer.restore_circuit_connections(entity, entity_data, entity_map)
        circuits_connected = circuits_connected + (connected or 0)
      end
    end
    
    -- Step 5: Restore power connections (copper cables between poles)
    log("[Import] Restoring power connections...")
    for _, entity_data in ipairs(entities_to_create) do
      local entity = entity_map[entity_data.entity_id]
      if entity and entity.valid then
        local connected = Deserializer.restore_power_connections(entity, entity_data, entity_map)
        power_connected = power_connected + (connected or 0)
      end
    end
    
    return { circuits_connected = circuits_connected, power_connected = power_connected }
end

return EntityStateRestoration