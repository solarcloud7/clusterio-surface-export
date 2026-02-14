local FluidRestoration = {}

--- Restore fluids to entities with network-aware optimization for Factorio 2.0
--- @param entities_to_create table: List of entity data objects
--- @param entity_map table: Map of entity_id to LuaEntity
function FluidRestoration.restore(entities_to_create, entity_map)
    log("[Import] Restoring fluids using segment aggregation...")

    -- Map segment_id -> {fluid=name, amount=total, energy=total_temp_product, targets={{ent, i}, ...}}
    local segments_to_fill = {}
    -- List of {entity, fluid, amount, temp} for entities not attached to valid segments
    local isolated_fluids = {}
    
    for _, entity_data in ipairs(entities_to_create) do
      local entity = entity_map[entity_data.entity_id]
      if entity and entity.valid and entity_data.specific_data and entity_data.specific_data.fluids then
         for _, fluid_data in ipairs(entity_data.specific_data.fluids) do
           local name = fluid_data.name
           local amount = fluid_data.amount or 0
           local temp = fluid_data.temperature or 15
           local assigned = false
  
           -- Iterate fluidboxes to find which segment this fluid belongs to
           if entity.fluidbox then
               for i = 1, #entity.fluidbox do
                  local seg_id = entity.fluidbox.get_fluid_segment_id(i)
                  -- Only consider if we have a segment ID
                  -- And if the box is compatible (no strict filter check here, relying on segment logic)
                  -- Optimistic matching: if the segment is already tracked for this fluid, matches.
                  -- Use the first compatible box/segment found.
                  
                  if seg_id then
                      local seg = segments_to_fill[seg_id]
                      local match = false
                      
                      if not seg then
                          -- New segment discovered, claim it for this fluid
                          segments_to_fill[seg_id] = {
                              fluid = name,
                              amount = 0,
                              energy = 0,
                              targets = {}
                          }
                          seg = segments_to_fill[seg_id]
                          match = true
                      elseif seg.fluid == name then
                          match = true
                      end
                      
                      if match then
                          seg.amount = seg.amount + amount
                          seg.energy = seg.energy + (amount * temp)
                          table.insert(seg.targets, {entity=entity, index=i})
                          assigned = true
                          break -- Fluid amount assigned to this segment, stop looking for other boxes for THIS fluid packet
                      end
                  end
               end
           end
           
           if not assigned then
              table.insert(isolated_fluids, {
                  entity = entity,
                  fluid = name,
                  amount = amount, 
                  temperature = temp
              })
           end
         end
      end
    end
  
    -- Process Segments with Capacity Safety
    -- CRITICAL (Factorio 2.0): get_capacity() returns INCONSISTENT values depending on entity type.
    -- For pipes/tanks: returns the FULL segment capacity (e.g., 11800)
    -- For thrusters/machines with internal buffers: returns LOCAL fluidbox capacity (e.g., 1000)
    -- Writing fluidbox[i]= on a pipe sets the SEGMENT total; on a thruster it only sets local buffer.
    -- Therefore we MUST pick the entity with the highest get_capacity() as injection target.
    local dropped_fluids = {}
    local dropped_count = 0
    local success_count = 0
  
    for seg_id, data in pairs(segments_to_fill) do
        if data.amount > 0 and #data.targets > 0 then
            -- Pick injection target: entity with highest get_capacity() to ensure we write to the segment
            -- Entities like pipes/tanks return segment capacity; thrusters return local capacity only
            local target = data.targets[1]
            local best_cap = target.entity.valid and target.entity.fluidbox.get_capacity(target.index) or 0
            for _, t in ipairs(data.targets) do
                if t.entity.valid then
                    local cap = t.entity.fluidbox.get_capacity(t.index)
                    if cap > best_cap then
                        target = t
                        best_cap = cap
                    end
                end
            end
            
            if target.entity.valid then
               local max_cap = best_cap
               
               -- Clamp amount to prevent silent loss without tracking and ensure valid assignment
               local final_amount = math.min(data.amount, max_cap)
               local avg_temp = data.amount > 0 and (data.energy / data.amount) or 15
               
               -- Log capacity details for debugging
               log(string.format("[Fluid Restore] Seg %d (%s): target=%s cap=%.0f data=%.1f final=%.1f targets=%d temp=%.1f",
                   seg_id, data.fluid, target.entity.name, max_cap, data.amount, final_amount, #data.targets, avg_temp))

               -- Use pcall for safety against "fluid mixing" errors if segment is somehow tainted
               local ok, err = pcall(function() 
                  target.entity.fluidbox[target.index] = {
                      name = data.fluid,
                      amount = final_amount,
                      temperature = avg_temp
                  }
               end)
               
               if not ok then
                   log(string.format("[Fluid Restore Error] Segment #%d (%s): %s", seg_id, data.fluid, err))
               else
                   success_count = success_count + 1
                   
                   -- Verify actual amount written by checking segment contents
                   local actual_contents = target.entity.fluidbox.get_fluid_segment_contents(target.index)
                   local actual_amount = actual_contents and actual_contents[data.fluid] or 0
                   if actual_amount < final_amount - 0.5 then
                       local write_loss = final_amount - actual_amount
                       log(string.format("[Fluid Restore Warning] Seg %d (%s): wrote %.1f but segment has %.1f (lost %.1f via %s)",
                           seg_id, data.fluid, final_amount, actual_amount, write_loss, target.entity.name))
                       dropped_fluids[data.fluid] = (dropped_fluids[data.fluid] or 0) + write_loss
                       dropped_count = dropped_count + 1
                   end
                   
                   -- Also check for pre-clamp overflow (source amount > segment capacity)
                   if data.amount > max_cap + 0.01 then
                      local diff = data.amount - max_cap
                      dropped_fluids[data.fluid] = (dropped_fluids[data.fluid] or 0) + diff
                      dropped_count = dropped_count + 1
                      log(string.format("[Fluid Restore Warning] Seg %d (%s): capacity overflow %.1f > %.0f (lost %.1f)",
                          seg_id, data.fluid, data.amount, max_cap, diff))
                   end
               end
            end
        end
    end
  
    if dropped_count > 0 then
        local msg = "[Fluid Restore Warning] Capacity limits reached! Dropped amounts: "
        for name, amount in pairs(dropped_fluids) do
            msg = msg .. string.format("%s=%.1f ", name, amount)
        end
        log(msg)
        game.print(msg, {1, 0.5, 0})
    end
    
    log(string.format("[Fluid Restore] Batch result: %d success, %d overflows.", success_count, dropped_count))
  
    -- Process Isolated Fluids (Fallback) - entities without a fluid segment ID
    local isolated_count = 0
    local isolated_lost = 0
    for _, item in ipairs(isolated_fluids) do
        if item.entity.valid then
            local inserted = item.entity.insert_fluid({
                name = item.fluid,
                amount = item.amount,
                temperature = item.temperature
            })
            isolated_count = isolated_count + 1
            if inserted < item.amount - 0.1 then
                local lost = item.amount - inserted
                isolated_lost = isolated_lost + lost
                log(string.format("[Fluid Restore Warning] Isolated %s on %s: wanted %.1f, inserted %.1f (lost %.1f)",
                    item.fluid, item.entity.name, item.amount, inserted, lost))
                dropped_fluids[item.fluid] = (dropped_fluids[item.fluid] or 0) + lost
            end
        end
    end
    
    if isolated_lost > 0 then
        log(string.format("[Fluid Restore Warning] Isolated entities lost %.1f total fluid", isolated_lost))
    end
    
    local total_restored = success_count + isolated_count
    log(string.format("[Import] Fluid restoration complete. Processed %d segments and %d isolated entities.", 
        table_size(segments_to_fill), #isolated_fluids))
    
    return { count = total_restored, segments = success_count, isolated = isolated_count }
end

return FluidRestoration