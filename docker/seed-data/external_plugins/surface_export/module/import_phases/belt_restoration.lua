local BeltRestoration = {}

--- Restore all belt items synchronously in a single tick
--- CRITICAL: Belts are always active and cannot be deactivated.
--- Items must be restored all at once to prevent partial restoration
--- where some items get picked up by inserters before others are placed.
---
--- Factorio 2.0: Items on belts can form stacks (piles) of up to 4 items per slot.
--- We use insert_at(position, ...) with exact positions from get_detailed_contents()
--- to place items at their original locations, avoiding "belt full" errors.
---
--- @param entities_to_create table: List of entity data objects
--- @param entity_map table: Map of entity_id to LuaEntity
function BeltRestoration.restore(entities_to_create, entity_map)
    log("[Import] Restoring belt items synchronously (Factorio 2.0 position-aware)...")
    
    local belt_count = 0
    local item_count = 0
    local failed_count = 0
    
    for _, entity_data in ipairs(entities_to_create) do
        local entity = entity_map[entity_data.entity_id]
        
        -- Skip if no entity or not a belt type
        if not entity or not entity.valid then
            goto continue
        end
        
        -- Check if this entity has belt items to restore
        if not entity_data.specific_data or not entity_data.specific_data.items then
            goto continue
        end
        
        -- Check if entity supports transport lines (is a belt)
        if not entity.get_transport_line then
            goto continue
        end
        
        belt_count = belt_count + 1
        
        -- Per-lane format: items = { {line=1, items={{name=..., position=..., count=..., quality=...}, ...}}, ... }
        for _, line_data in ipairs(entity_data.specific_data.items) do
            local line = entity.get_transport_line(line_data.line)
            if line and line.valid then
                for _, item in ipairs(line_data.items) do
                    local success = false
                    local stack = {
                        name = item.name,
                        count = item.count,
                        quality = item.quality or "normal"
                    }
                    
                    -- Use insert_at with exact position if available (new format)
                    if item.position then
                        success = line.insert_at(item.position, stack, item.count)
                    end
                    
                    -- Fallback to insert_at_back for old format or if position insert failed
                    if not success then
                        success = line.insert_at_back(stack, item.count)
                    end
                    
                    if success then
                        item_count = item_count + item.count
                    else
                        failed_count = failed_count + item.count
                        log(string.format("[Belt Restore] Could not insert %d x %s onto belt %s line %d (pos=%s)",
                            item.count, item.name, entity.name, line_data.line, 
                            tostring(item.position or "back")))
                    end
                end
            end
        end
        
        ::continue::
    end
    
    log(string.format("[Import] Belt restoration complete. Processed %d belts, %d items placed, %d failed.",
        belt_count, item_count, failed_count))
    
    if failed_count > 0 then
        game.print(string.format("[Import Warning] Failed to place %d belt items", failed_count), {1, 0.5, 0})
    end
    
    return { belts_processed = belt_count, items_restored = item_count, items_failed = failed_count }
end

return BeltRestoration