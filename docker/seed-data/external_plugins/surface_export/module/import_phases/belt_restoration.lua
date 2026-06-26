local GameUtils = require("modules/surface_export/utils/game-utils")
local VersionCompat = require("modules/surface_export/utils/version-compat")

local BeltRestoration = {}

local QUALITY_NORMAL = GameUtils.QUALITY_NORMAL

--- Restore all belt items synchronously in a single tick.
--- CRITICAL: Belts are always active and cannot be deactivated, so items must be restored all at once.
---
--- Factorio 2.0.76 LuaTransportLine API (signature routed through version-compat.lua; source of truth is
--- lua-api.factorio.com/2.0.76/, NOT the "latest" docs which reorder the params):
---     insert_at(position, items, belt_stack_size?) -> bool     (position FIRST; belt_stack_size caps the slot)
---
--- THE FIX (verified empirically, apples-to-apples, on the pinned engine):
--- Re-insert each captured slot at its EXACT position, but in ASCENDING POSITION ORDER. A controlled
--- single-loop experiment (custom surface, items packed by real belt movement, source-vs-dest physical
--- counts) showed:
---   * Inserting in the captured (UNSORTED) order — what the old code did — lets an earlier insert occupy a
---     slot a later item needs, so insert_at PARTIAL-places and returns true anyway (the bool lies). Result:
---     a few items silently dropped (e.g. 112 -> 108, 28 -> 27).
---   * Inserting SORTED BY POSITION (ascending) makes every item land at its exact position because each new
---     item goes ahead of all already-placed ones — no collisions. Result: 100% on-belt, ZERO shortfall,
---     every can_insert_at a hit, across single items (belt_stack_size 1) and full stacks (4).
--- The items demonstrably fit — they were on a belt at the source — so they go back ON the belt. There is NO
--- ground-spill: items that were on belts must stay on belts. The only fallback (which the experiment never
--- needed) keeps any rare residual ON THE SAME LINE via insert_at_back, and a genuine failure is LOGGED loudly
--- rather than hidden or dropped on the floor.
---
--- @param entities_to_create table: List of entity data objects
--- @param entity_map table: Map of entity_id to LuaEntity
function BeltRestoration.restore(entities_to_create, entity_map)
    log("[Import] Restoring belt items (2.0.76: sort slots by position, then insert_at — 100% on-belt)...")

    local belt_count = 0
    local placed_count = 0
    local backfilled_count = 0  -- rare on-belt insert_at_back fallback (never ground)
    local failed_count = 0      -- genuinely could not place ON the belt (expected: 0)

    for _, entity_data in ipairs(entities_to_create) do
        local entity = entity_map[entity_data.entity_id]

        if not entity or not entity.valid then goto continue end
        if not entity_data.specific_data or not entity_data.specific_data.items then goto continue end
        if not entity.get_transport_line then goto continue end

        belt_count = belt_count + 1

        for _, line_data in ipairs(entity_data.specific_data.items) do
            local line = entity.get_transport_line(line_data.line)
            if line and line.valid then
                -- Collect this line's slots and the expected total, then SORT BY POSITION ASCENDING.
                -- This is the fix: position order = collision-free placement (see header).
                local slots = {}
                local expected = 0
                for _, item in ipairs(line_data.items) do
                    slots[#slots + 1] = item
                    expected = expected + item.count
                end
                table.sort(slots, function(a, b) return (a.position or 0) < (b.position or 0) end)

                for _, item in ipairs(slots) do
                    local stack = {
                        name = item.name,
                        count = item.count,
                        quality = item.quality or QUALITY_NORMAL,
                    }
                    -- belt_stack_size = item.count (the captured slot's stack; turbo cap is 4). The bool is
                    -- NOT trusted for accounting — the per-line physical verify below is authoritative.
                    if item.position then
                        local ok, res = pcall(function()
                            return VersionCompat.belt_insert_at(line, item.position, stack, item.count)
                        end)
                        if not ok then
                            log(string.format("[Belt Restore] insert_at ERROR on %s line %d (pos=%s): %s",
                                entity.name, line_data.line, tostring(item.position), tostring(res)))
                        end
                    else
                        -- Positionless slot (rare): append at the back, on the belt.
                        local ok, res = pcall(function()
                            return VersionCompat.belt_insert_at_back(line, stack, item.count)
                        end)
                        if not ok then
                            log(string.format("[Belt Restore] insert_at_back ERROR on %s line %d: %s",
                                entity.name, line_data.line, tostring(res)))
                        end
                    end
                end

                -- Per-line physical verify (authoritative — does not trust the insert bool). Sorted
                -- insertion is exact in every tested case, so this is defensive. Any residual stays ON THE
                -- BELT (insert_at_back on the SAME line); it is NEVER spilled to the ground.
                local actual = line.get_item_count()
                placed_count = placed_count + math.min(actual, expected)

                if actual < expected then
                    log(string.format("[Belt Restore] %s line %d short after sorted insert (%d/%d) — on-belt back-fill",
                        entity.name, line_data.line, actual, expected))
                    for _, item in ipairs(slots) do
                        local stack = {
                            name = item.name,
                            count = item.count,
                            quality = item.quality or QUALITY_NORMAL,
                        }
                        while line.get_item_count() < expected and line.can_insert_at_back() do
                            local ok, res = pcall(function()
                                return VersionCompat.belt_insert_at_back(line, stack, item.count)
                            end)
                            if not ok then
                                log(string.format("[Belt Restore] back-fill insert_at_back ERROR on %s line %d: %s",
                                    entity.name, line_data.line, tostring(res)))
                                break
                            end
                            if res ~= true then break end
                            backfilled_count = backfilled_count + item.count
                        end
                        if line.get_item_count() >= expected then break end
                    end

                    local final = line.get_item_count()
                    if final < expected then
                        -- Could not place on the belt at all. Do NOT ground-spill and do NOT hide it.
                        failed_count = failed_count + (expected - final)
                        log(string.format("[Belt Restore] LOST %d belt items on %s line %d — line could not hold them (NOT ground-spilled)",
                            expected - final, entity.name, line_data.line))
                    end
                end
            end
        end

        ::continue::
    end

    log(string.format("[Import] Belt restoration complete. Processed %d belts, %d items on belts (%d via back-fill), %d lost.",
        belt_count, placed_count, backfilled_count, failed_count))

    if failed_count > 0 then
        game.print(string.format("[Import Warning] %d belt items could not be placed on belts", failed_count), {1, 0.5, 0})
    end

    return {
        belts_processed = belt_count,
        items_restored = placed_count,
        items_backfilled = backfilled_count,
        items_failed = failed_count,
    }
end

return BeltRestoration
