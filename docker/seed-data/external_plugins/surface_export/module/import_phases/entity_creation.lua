local Deserializer = require("modules/surface_export/core/deserializer")
local Util = require("modules/surface_export/utils/util")
local EntityCreation = {}

local function carries_inventory_items(entity_data)
  local sd = entity_data.specific_data
  if not sd or not sd.inventories then return false end
  for _, inv in ipairs(sd.inventories) do
    if inv.items and #inv.items > 0 then return true end
  end
  return false
end

local function carries_fluids(entity_data)
  local sd = entity_data.specific_data
  if not sd or not sd.fluidboxes then return false end
  for _, box in ipairs(sd.fluidboxes) do
    if (box.local_amount or 0) > 0 then return true end
  end
  return false
end

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
        if entity_data._beacon_placed then
          batch_created = batch_created + 1
        elseif entity_data.type == "item-on-ground" then
          local created = Deserializer.create_ground_item(job.target_surface, entity_data)
          if created and created.valid then
            batch_created = batch_created + 1
          else
            batch_failed = batch_failed + 1
            local losses = job.failed_entity_losses
            if not losses then
              losses = { entity_count = 0, total_items = 0, total_fluids = 0.0, items = {}, fluids = {}, entities = {} }
              job.failed_entity_losses = losses
            end
            local item_key = Util.make_quality_key(entity_data.name, entity_data.quality or Util.QUALITY_NORMAL)
            losses.items[item_key] = (losses.items[item_key] or 0) + (entity_data.count or 0)
            losses.total_items = losses.total_items + (entity_data.count or 0)
            losses.entity_count = losses.entity_count + 1
            log(string.format("[Entity Creation] FAILED to place ground item '%s' x%d at (%.1f,%.1f) -- tallied as loss",
              entity_data.name, entity_data.count or 0, entity_data.position.x, entity_data.position.y))
          end
        else
          local entity
          local _cfg = storage.surface_export_config
          local failure_mode = _cfg and _cfg.test_force_entity_failure
          local fluid_target = type(failure_mode) == "string"
            and string.match(failure_mode, "^inventory_and_fluid:(.+)$") or nil
          local fluid_x, fluid_y = nil, nil
          if type(failure_mode) == "string" then
            fluid_x, fluid_y = string.match(failure_mode, "^inventory_and_fluid_at:([^:]+):([^:]+)$")
          end
          local position_matches = fluid_x and fluid_y and entity_data.position
            and math.abs((entity_data.position.x or entity_data.position[1]) - tonumber(fluid_x)) < 0.001
            and math.abs((entity_data.position.y or entity_data.position[2]) - tonumber(fluid_y)) < 0.001
          if type(failure_mode) == "string" and not fluid_target and not fluid_x
              and not job.warned_unrecognized_failure_mode then
            job.warned_unrecognized_failure_mode = true
            log(string.format("[TEST HOOK] WARNING: test_force_entity_failure=%q matches no known pattern (inventory_and_fluid:<name> | inventory_and_fluid_at:<x>:<y> | true) — hook stays armed but will never fire", failure_mode))
          end
          local matches_failure_mode = (fluid_target ~= nil
            and entity_data.name == fluid_target
            or position_matches)
            and carries_inventory_items(entity_data) and carries_fluids(entity_data)
            or failure_mode == true and carries_inventory_items(entity_data)
          if _cfg and _cfg.debug_mode and matches_failure_mode
              and entity_data.name ~= "space-platform-hub" then
            _cfg.test_force_entity_failure = nil
            job.test_forced_entity_failure = true
            entity = nil
            log(string.format("[TEST HOOK] Forcing placement failure for %s entity '%s' to exercise failed-entity-loss attribution",
              tostring(failure_mode), entity_data.name))
          else
            entity = Deserializer.create_entity(job.target_surface, entity_data)
          end
          if entity and entity.valid then
            batch_created = batch_created + 1
            if entity_data.entity_id then
              job.entity_map[entity_data.entity_id] = entity
            end
            
            if job.transfer_id and entity.type ~= "beacon" and entity.type ~= "radar"
                and entity.type ~= "item-request-proxy" then
              local ok, err = pcall(function()
                if entity.active then
                  entity.disabled_by_script = true
                end
              end)
              if not ok then
                log(string.format("[Import] Failed to deactivate entity %s: %s", entity.name, tostring(err)))
              end
            end
            
            Deserializer.restore_entity_state(entity, entity_data)
          else
            if entity_data.name == "space-platform-hub" then
              batch_skipped = batch_skipped + 1
            else
              batch_failed = batch_failed + 1

              local losses = job.failed_entity_losses
              if not losses then
                losses = { entity_count = 0, total_items = 0, total_fluids = 0.0, items = {}, fluids = {}, entities = {} }
                job.failed_entity_losses = losses
              end

              local entity_items = 0
              local entity_fluids = 0.0

              if entity_data.specific_data then
                if entity_data.specific_data.inventories then
                  for _, inv_data in ipairs(entity_data.specific_data.inventories) do
                    for _, item in ipairs(inv_data.items or {}) do
                      local item_key = Util.make_quality_key(item.name, item.quality or Util.QUALITY_NORMAL)
                      losses.items[item_key] = (losses.items[item_key] or 0) + item.count
                      entity_items = entity_items + item.count
                    end
                  end
                end
                if entity_data.specific_data.items then
                  for _, line_data in ipairs(entity_data.specific_data.items) do
                    for _, item in ipairs(line_data.items or {}) do
                      local item_key = Util.make_quality_key(item.name, item.quality or Util.QUALITY_NORMAL)
                      losses.items[item_key] = (losses.items[item_key] or 0) + item.count
                      entity_items = entity_items + item.count
                    end
                  end
                end
                if entity_data.specific_data.held_item then
                  local held = entity_data.specific_data.held_item
                  local item_key = Util.make_quality_key(held.name, held.quality or Util.QUALITY_NORMAL)
                  losses.items[item_key] = (losses.items[item_key] or 0) + held.count
                  entity_items = entity_items + held.count
                end
                if entity_data.specific_data.fluidboxes then
                  for _, box in ipairs(entity_data.specific_data.fluidboxes) do
                    local amount = box.local_amount or 0
                    if amount > 0 then
                      local key = "box" .. tostring(box.box_index)
                      losses.fluids[key] = (losses.fluids[key] or 0.0) + amount
                      entity_fluids = entity_fluids + amount
                    end
                  end
                end
              end

              losses.entity_count = losses.entity_count + 1
              losses.total_items = losses.total_items + entity_items
              losses.total_fluids = losses.total_fluids + entity_fluids

              if #losses.entities < 50 then
                table.insert(losses.entities, {
                  name = entity_data.name or "?",
                  type = entity_data.type or "?",
                  position = entity_data.position,
                  items = entity_items,
                  fluids = entity_fluids,
                })
              end

              log(string.format("[Entity Creation] FAILED to create '%s' (type=%s) at (%.1f,%.1f) — lost %d items, %.1f fluids — index %d/%d",
                entity_data.name or "?", entity_data.type or "?",
                entity_data.position and (entity_data.position.x or entity_data.position[1]) or 0,
                entity_data.position and (entity_data.position.y or entity_data.position[2]) or 0,
                entity_items, entity_fluids, i, job.total_entities))
            end
          end
        end
      else
        batch_skipped = batch_skipped + 1
        log(string.format("[Entity Creation] HOLE in entities_to_create at index %d/%d (job=%s) — "
          .. "a payload element is missing, not skipped by design", i, job.total_entities, job.job_id))
      end
    end
    
    job.current_index = end_index

    job.metrics = job.metrics or {}
    job.metrics.entities_created = (job.metrics.entities_created or 0) + batch_created
    job.metrics.entities_failed = (job.metrics.entities_failed or 0) + batch_failed
    job.metrics.entities_skipped = (job.metrics.entities_skipped or 0) + batch_skipped


    local batch_num = math.floor(end_index / batch_size)
    if batch_num <= 5 or batch_num % 10 == 0 or end_index >= job.total_entities then
      log(string.format("[Entity Creation] Batch %d: entities %d-%d/%d, created=%d, failed=%d, skipped=%d (job=%s)",
        batch_num, start_index, end_index, job.total_entities,
        batch_created, batch_failed, batch_skipped, job.job_id))
    end
    
    if should_show_progress() and end_index % (batch_size * 10) == 0 then
      local progress = math.floor((end_index / job.total_entities) * 100)
      game.print(string.format("[Import %s] Progress: %d%% (%d/%d entities)",
        job.platform_name, progress, end_index, job.total_entities))
    end
    
    return job.current_index >= job.total_entities
end

return EntityCreation
