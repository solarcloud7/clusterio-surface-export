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
    local dropped_fluids = {}
    local dropped_count = 0
    local success_count = 0
  
    for seg_id, data in pairs(segments_to_fill) do
        if data.amount > 0 and #data.targets > 0 then
            local target = data.targets[1]
            -- Prioritize storage tanks for injection
            for _, t in ipairs(data.targets) do
                if t.entity.type == "storage-tank" then
                    target = t
                    break
                end
            end
            
            if target.entity.valid then
               -- Factorio 2.0: Read total segment capacity
               -- get_capacity returns the capacity of the entire fluid segment
               local max_cap = target.entity.fluidbox.get_capacity(target.index)
               
               -- Clamp amount to prevent silent loss without tracking and ensure valid assignment
               local final_amount = math.min(data.amount, max_cap)
               local avg_temp = data.amount > 0 and (data.energy / data.amount) or 15
               
               -- DEBUG: Log capacity details for sensitive entities like thrusters
               if target.entity.name == "thruster" or max_cap < data.amount then
                  log(string.format("[Fluid Restore DEBUG] %s (seg %d): cap=%.1f data=%.1f final=%.1f boxlen=%d temp=%.1f",
                      target.entity.name, seg_id, max_cap, data.amount, final_amount, #target.entity.fluidbox, avg_temp))
               end

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
                   -- Check for overflow (source amount > segment capacity)
                   if data.amount > max_cap + 0.01 then -- Small epsilon for float comparison
                      local diff = data.amount - max_cap
                      dropped_fluids[data.fluid] = (dropped_fluids[data.fluid] or 0) + diff
                      dropped_count = dropped_count + 1
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
  
    -- Process Isolated Fluids (Fallback)
    local isolated_count = 0
    for _, item in ipairs(isolated_fluids) do
        if item.entity.valid then
            item.entity.insert_fluid({
                name = item.fluid,
                amount = item.amount,
                temperature = item.temperature
            })
            isolated_count = isolated_count + 1
        end
    end
    
    local total_restored = success_count + isolated_count
    log(string.format("[Import] Fluid restoration complete. Processed %d segments and %d isolated entities.", 
        table_size(segments_to_fill), #isolated_fluids))
    
    return { count = total_restored, segments = success_count, isolated = isolated_count }
end

return FluidRestoration