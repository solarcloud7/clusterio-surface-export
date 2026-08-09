local Deserializer = require("modules/surface_export/core/deserializer")
local EntityStateRestoration = {}

function EntityStateRestoration.restore_all(entities_to_create, entity_map)
    local circuits_connected = 0
    local power_connected = 0
    
    log("[Import] Restoring control behavior...")
    for _, entity_data in ipairs(entities_to_create) do
      local entity = entity_map[entity_data.entity_id]
      if entity and entity.valid then
        Deserializer.restore_control_behavior(entity, entity_data)
      end
    end
    

    log("[Import] Restoring entity filters...")
    for _, entity_data in ipairs(entities_to_create) do
      local entity = entity_map[entity_data.entity_id]
      if entity and entity.valid then
        Deserializer.restore_entity_filters(entity, entity_data)
      end
    end
    
    local legacy_request_entities = 0
    for _, entity_data in ipairs(entities_to_create) do
      if entity_data.logistic_requests ~= nil then
        legacy_request_entities = legacy_request_entities + 1
      end
    end
    if legacy_request_entities > 0 then
      log(string.format(
        "[Import] NOTICE: payload carries the retired pre-2.0 logistic_requests field on %d entities — the 1.1 request-slot API does not exist on this engine, so those request slots are NOT restored (requester state rides logistic_sections)",
        legacy_request_entities))
    end

    log("[Import] Restoring logistic sections...")
    local created_logistic_groups = {}
    for _, entity_data in ipairs(entities_to_create) do
      local entity = entity_map[entity_data.entity_id]
      if entity and entity.valid then
        for _, group_name in ipairs(Deserializer.restore_logistic_sections(entity, entity_data)) do
          table.insert(created_logistic_groups, group_name)
        end
      end
    end

    log("[Import] Restoring circuit connections...")
    for _, entity_data in ipairs(entities_to_create) do
      local entity = entity_map[entity_data.entity_id]
      if entity and entity.valid then
        local connected = Deserializer.restore_circuit_connections(entity, entity_data, entity_map)
        circuits_connected = circuits_connected + (connected or 0)
      end
    end
    
    log("[Import] Restoring power connections...")
    for _, entity_data in ipairs(entities_to_create) do
      local entity = entity_map[entity_data.entity_id]
      if entity and entity.valid then
        local connected = Deserializer.restore_power_connections(entity, entity_data, entity_map)
        power_connected = power_connected + (connected or 0)
      end
    end
    
    return {
      circuits_connected = circuits_connected,
      power_connected = power_connected,
      created_logistic_groups = created_logistic_groups,
    }
end

return EntityStateRestoration