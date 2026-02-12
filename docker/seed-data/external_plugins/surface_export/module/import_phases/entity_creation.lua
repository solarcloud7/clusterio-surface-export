local Deserializer = require("modules/surface_export/core/deserializer")
local EntityCreation = {}

--- Process a batch of entity creation
--- @param job table: The import job state
--- @param get_batch_size function: Function to get current batch size
--- @param should_show_progress function: Function to check if progress should be shown
--- @return boolean: true if job is complete for this tick (either finished or batch reached)
function EntityCreation.process_batch(job, get_batch_size, should_show_progress)
    local batch_size = get_batch_size()
    local start_index = job.current_index + 1
    local end_index = math.min(start_index + batch_size - 1, job.total_entities)
    
    local batch_created = 0
    local batch_failed = 0
    local batch_skipped = 0
    
    for i = start_index, end_index do
      local entity_data = job.entities_to_create[i]
      if entity_data then
        if entity_data.type == "item-on-ground" then
          Deserializer.create_ground_item(job.target_surface, entity_data)
          batch_created = batch_created + 1
        else
          local entity = Deserializer.create_entity(job.target_surface, entity_data)
          if entity and entity.valid then
            batch_created = batch_created + 1
            -- Store in entity_map for post-processing (circuit connections, etc.)
            if entity_data.entity_id then
              job.entity_map[entity_data.entity_id] = entity
              -- DEBUG: Log entity_id mapping for first few entities
              if i <= 5 then
                log(string.format("[DEBUG] entity_map[%s] = %s (new unit_number=%s)",
                  tostring(entity_data.entity_id),
                  entity.name,
                  tostring(entity.unit_number)))
              end
            else
              -- DEBUG: Log entities missing entity_id
              log(string.format("[DEBUG WARNING] Entity %s at (%.1f,%.1f) has NO entity_id!",
                entity_data.name,
                entity_data.position.x or entity_data.position[1] or 0,
                entity_data.position.y or entity_data.position[2] or 0))
            end
            
            -- CRITICAL: If this is a transfer, deactivate entity BEFORE restoring state/inventories
            -- This prevents crafting machines from starting to consume items the moment we set their recipe
            if job.transfer_id then
              local ok, err = pcall(function()
                if entity.active then
                  entity.active = false
                end
              end)
              if not ok then
                log(string.format("[Import] Failed to deactivate entity %s: %s", entity.name, tostring(err)))
              end
            end
            
            -- Now safely restore state with entity deactivated
            -- NOTE: Fluids are restored in post-processing phase (complete_import_job)
            -- This is CRITICAL because restoring fluids immediately causes fluid network
            -- redistribution when connected pipes/tanks are created later in the batch
            Deserializer.restore_entity_state(entity, entity_data)
            Deserializer.restore_inventories(entity, entity_data)
          else
            batch_failed = batch_failed + 1
            log(string.format("[Entity Creation] FAILED to create entity '%s' (type=%s) at (%.1f,%.1f) - index %d/%d",
              entity_data.name or "?", entity_data.type or "?",
              entity_data.position and (entity_data.position.x or entity_data.position[1]) or 0,
              entity_data.position and (entity_data.position.y or entity_data.position[2]) or 0,
              i, job.total_entities))
          end
        end
      else
        batch_skipped = batch_skipped + 1
      end
    end
    
    job.current_index = end_index
    
    -- Log batch summary (every batch for first 5 and every 10th after)
    local batch_num = math.floor(end_index / batch_size)
    if batch_num <= 5 or batch_num % 10 == 0 or end_index >= job.total_entities then
      log(string.format("[Entity Creation] Batch %d: entities %d-%d/%d, created=%d, failed=%d, skipped=%d (job=%s)",
        batch_num, start_index, end_index, job.total_entities,
        batch_created, batch_failed, batch_skipped, job.job_id))
    end
    
    -- Show progress every 10 batches
    if should_show_progress() and end_index % (batch_size * 10) == 0 then
      local progress = math.floor((end_index / job.total_entities) * 100)
      game.print(string.format("[Import %s] Progress: %d%% (%d/%d entities)",
        job.platform_name, progress, end_index, job.total_entities))
    end
    
    return job.current_index >= job.total_entities
end

return EntityCreation