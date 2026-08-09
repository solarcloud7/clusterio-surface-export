local Deserializer = require("modules/surface_export/core/deserializer")

local PlatformHubMapping = {}

function PlatformHubMapping.process(job)
    if job.hub_mapped then
        return true
    end

    if not job.entities_to_create then
        job.hub_mapped = true
        return true
    end

    for _, entity_data in ipairs(job.entities_to_create) do
      if entity_data.name == "space-platform-hub" then
        local hub = job.target_surface.find_entity("space-platform-hub", {0, 0})
        if hub and hub.valid then
          job.entity_map[entity_data.entity_id] = hub
          log(string.format("[Import] Mapped existing space-platform-hub (new unit_number=%s) to old entity_id=%s",
            tostring(hub.unit_number), tostring(entity_data.entity_id)))
          
          if job.transfer_id then
            local ok, err = pcall(function()
              if hub.active then hub.disabled_by_script = true end
            end)
            if not ok then
              log(string.format("[Import] Failed to deactivate hub: %s", tostring(err)))
            end
          end
          
          job.hub_entity_data = entity_data
          log("[Import] Hub mapped — inventory restoration deferred until after entity creation (cargo bays needed)")
        else
          log("[Import WARNING] Could not find space-platform-hub on target surface")
        end
        break
      end
    end
    job.hub_mapped = true
    return true
end

function PlatformHubMapping.restore_hub_inventories(job)
    local entity_data = job.hub_entity_data
    if not entity_data then
      return
    end
    
    local hub = (job.entity_map or {})[entity_data.entity_id]
    if not hub or not hub.valid then
      log("[Import WARNING] Hub entity invalid during deferred inventory restoration")
      return
    end
    
    local inv = hub.get_inventory(defines.inventory.hub_main)
    local slots_before = inv and #inv or 0
    
    Deserializer.restore_entity_state(hub, entity_data)
    Deserializer.restore_inventories(hub, entity_data)
    
    log(string.format("[Import] Restored space-platform-hub state and inventories (hub_main slots=%d)", slots_before))
end

return PlatformHubMapping