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
    
    -- Step 1b: MINING PROGRESS. NECESSARY BUT NOT YET SUFFICIENT — the drain below is NOT fixed.
    --
    -- The problem: a fluid-consuming drill charges its whole cycle cost UP FRONT, so one that
    -- arrives at progress 0 starts a fresh cycle and pays again — a silent 10 sulfuric-acid drain
    -- per transfer on the acid-drill pad. The exact gate cannot see it: the gate closes
    -- pre-activation and the drill spends the acid once it is woken.
    --
    -- Measured 2026-07-28/29, transferring a drill with a marker progress of 0.77:
    --   * capture WORKS — mining_progress is in the payload
    --   * a direct write STICKS, including across deactivate -> write -> reactivate, and holds
    --   * restoring at CREATION (a SIMPLE_RESTORE_RULES row) did not stick: the marker arrived 0.02
    --   * restoring HERE, after every entity is placed, ALSO did not stick: still 0.02
    -- So something after this pass resets it, or this pass is not reached on the transfer path.
    -- UNRESOLVED — do not describe this as fixed. Next step is to log the value immediately after
    -- the write and again just before activation, to find which of the two it is.
    log("[Import] Restoring mining progress...")
    for _, entity_data in ipairs(entities_to_create) do
      local entity = entity_map[entity_data.entity_id]
      local sd = entity_data.specific_data
      if entity and entity.valid and sd then
        for _, field in ipairs({ "mining_progress", "bonus_mining_progress" }) do
          if sd[field] then
            local ok, err = pcall(function() entity[field] = sd[field] end)
            if not ok then
              log(string.format("[Import] %s restore failed for '%s': %s",
                field, tostring(entity.name), tostring(err)))
            end
          end
        end
      end
    end

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