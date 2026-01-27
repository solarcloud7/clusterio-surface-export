local PlatformHubMapping = {}

--- Map the existing space-platform-hub to the entity map
--- @param job table: The import job state
--- @return boolean: always true (side effect only)
function PlatformHubMapping.process(job)
    if job.hub_mapped then
        return true
    end

    if not job.entities_to_create then
        job.hub_mapped = true
        return true
    end

    -- CRITICAL: Map existing space-platform-hub to entity_map using the OLD entity_id
    -- The hub is created automatically with the platform and can't be manually created
    -- We need to find it on the target surface and map it to the original entity_id
    for _, entity_data in ipairs(job.entities_to_create) do
      if entity_data.name == "space-platform-hub" then
        -- Find the existing hub on the target surface
        local hub = job.target_surface.find_entity("space-platform-hub", {0, 0})
        if hub and hub.valid then
          job.entity_map[entity_data.entity_id] = hub
          log(string.format("[Import] Mapped existing space-platform-hub (new unit_number=%s) to old entity_id=%s",
            tostring(hub.unit_number), tostring(entity_data.entity_id)))
        else
          log("[Import WARNING] Could not find space-platform-hub on target surface")
        end
        break
      end
    end
    job.hub_mapped = true
    return true
end

return PlatformHubMapping