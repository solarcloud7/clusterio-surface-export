local GameUtils = require("modules/surface_export/utils/game-utils")

local BeltRestoration = {}

--- Restore all belt items synchronously in a single tick.
--- CRITICAL: Belts are always active and cannot be deactivated, so items must be restored all at once.
---
--- Factorio 2.0.76 LuaTransportLine API — VERIFIED EMPIRICALLY on the pinned engine (do NOT trust the
--- "latest" lua-api docs: they describe a POST-2.0.76 signature with a `belt_stack_size` param that does
--- NOT exist here):
---     insert_at(position, items, count) -> bool     [position runs 0..line_length; count = how many to place]
---     insert_at_back(items, count) -> bool
--- Proof (fresh turbo belt): insert_at(pos, {iron-plate,count=4}, 4) places 4; WITHOUT the count arg it
--- places only 1 (the count defaults to 1 — this exact omission once dropped ~72% of stacked-belt items
--- while the meter still reported "0 lost"). insert_at_back(4, items) ERRORS "items: table expected, got
--- number" (the latest-docs belt_stack_size form). Recheck if the engine is upgraded.
---
--- A few items on DENSE turbo belts cannot be re-inserted at their exact source positions (the line packs
--- slightly differently on restore and fills before the last items). To GUARANTEE zero item loss
--- (debit == credit), those few are spilled onto the adjacent ground — they stay on the platform, counted
--- in the total, merely relocated from a full belt to the floor (becoming item-on-ground entities).
--- All API errors are LOGGED, never swallowed.
---
--- @param entities_to_create table: List of entity data objects
--- @param entity_map table: Map of entity_id to LuaEntity
function BeltRestoration.restore(entities_to_create, entity_map)
    log("[Import] Restoring belt items (Factorio 2.0.76 insert_at(position, items))...")

    local belt_count = 0
    local item_count = 0
    local failed_count = 0
    local relocated_count = 0

    for _, entity_data in ipairs(entities_to_create) do
        local entity = entity_map[entity_data.entity_id]

        if not entity or not entity.valid then
            goto continue
        end
        if not entity_data.specific_data or not entity_data.specific_data.items then
            goto continue
        end
        if not entity.get_transport_line then
            goto continue
        end

        belt_count = belt_count + 1

        for _, line_data in ipairs(entity_data.specific_data.items) do
            local line = entity.get_transport_line(line_data.line)
            if line and line.valid then
                for _, item in ipairs(line_data.items) do
                    local stack = {
                        name = item.name,
                        count = item.count,
                        quality = item.quality or GameUtils.QUALITY_NORMAL
                    }
                    local success = false

                    -- Primary: insert `item.count` items at the exact source position.
                    -- 2.0.76 form: insert_at(position, items, COUNT) — the 3rd arg is how many to place
                    -- (verified empirically: insert_at(pos, {count=4}, 4) places 4; without it, only 1).
                    if item.position then
                        local ok, res = pcall(function() return line.insert_at(item.position, stack, item.count) end)
                        if not ok then
                            log(string.format("[Belt Restore] insert_at ERROR on %s line %d (pos=%s): %s",
                                entity.name, line_data.line, tostring(item.position), tostring(res)))
                        end
                        success = ok and res == true
                    end

                    -- Fallback: append at the back of the line. 2.0.76 form: insert_at_back(items, COUNT).
                    if not success then
                        local ok, res = pcall(function() return line.insert_at_back(stack, item.count) end)
                        if not ok then
                            log(string.format("[Belt Restore] insert_at_back ERROR on %s line %d: %s",
                                entity.name, line_data.line, tostring(res)))
                        end
                        success = ok and res == true
                    end

                    if success then
                        item_count = item_count + item.count
                    else
                        -- Line genuinely full on restore: relocate to the adjacent ground to GUARANTEE
                        -- no item loss. Rare (~0.15-0.5% of belt items, dense turbo belts).
                        local ok, spilled = pcall(function()
                            return entity.surface.spill_item_stack({
                                position = entity.position,
                                stack = stack,
                                enable_looted = false,
                                allow_belts = false,
                            })
                        end)
                        if ok and spilled and #spilled > 0 then
                            item_count = item_count + item.count
                            relocated_count = relocated_count + item.count
                        else
                            failed_count = failed_count + item.count
                            log(string.format("[Belt Restore] LOST %d x %s on %s line %d — line full AND ground spill failed (err=%s)",
                                item.count, item.name, entity.name, line_data.line, tostring(spilled)))
                        end
                    end
                end
            end
        end

        ::continue::
    end

    log(string.format("[Import] Belt restoration complete. Processed %d belts, %d items placed (%d relocated to ground), %d lost.",
        belt_count, item_count, relocated_count, failed_count))

    if relocated_count > 0 then
        log(string.format("[Belt Restore] %d belt items relocated to adjacent ground (line full on restore) — NO item loss",
            relocated_count))
    end
    if failed_count > 0 then
        game.print(string.format("[Import Warning] LOST %d belt items (line full AND ground spill failed)", failed_count), {1, 0.5, 0})
    end

    return { belts_processed = belt_count, items_restored = item_count, items_relocated = relocated_count, items_failed = failed_count }
end

return BeltRestoration
