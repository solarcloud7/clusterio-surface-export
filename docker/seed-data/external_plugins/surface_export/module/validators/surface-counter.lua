-- FactorioSurfaceExport - Surface Counter
-- Unified live-surface counting for items and fluids.
-- Single source of truth used by verification, transfer-validation, and loss analysis.

local InventoryScanner = require("modules/surface_export/export_scanners/inventory-scanner")
local GameUtils = require("modules/surface_export/utils/game-utils")
local Util = require("modules/surface_export/utils/util")

local SurfaceCounter = {}

--- Count all items on a live surface
--- Scans inventories, belt items, inserter held items, and ground items.
--- @param surface LuaSurface: The surface to count items on
--- @return table, number: item_key→count map, total item count
function SurfaceCounter.count_items(surface)
    if not surface or not surface.valid then
        return {}, 0
    end

    local item_totals = {}
    local total = 0

    local entities = surface.find_entities_filtered({})

    for _, entity in ipairs(entities) do
        if entity.valid then
            local etype = entity.type

            -- Inventory items (pcall-protected: some entities may not support inventory access)
            local success, err = pcall(function()
                local inventories = InventoryScanner.extract_all_inventories(entity)
                local inv_totals = InventoryScanner.count_all_items(inventories)
                for key, count in pairs(inv_totals) do
                    item_totals[key] = (item_totals[key] or 0) + count
                    total = total + count
                end
            end)

            if not success then
                log(string.format("[SurfaceCounter] Error counting inventories for entity %s: %s", entity.name, err))
            end

            -- Belt items
            if GameUtils.BELT_ENTITY_TYPES[etype] then
                local ok, belt_err = pcall(function()
                    local belt_lines = InventoryScanner.extract_belt_items(entity)
                    for _, line_data in ipairs(belt_lines) do
                        if line_data.items then
                            for _, item in ipairs(line_data.items) do
                                local key = Util.make_quality_key(item.name, item.quality or Util.QUALITY_NORMAL)
                                item_totals[key] = (item_totals[key] or 0) + item.count
                                total = total + item.count
                            end
                        end
                    end
                end)

                if not ok then
                    log(string.format("[SurfaceCounter] Error counting belt items for entity %s: %s", entity.name, belt_err))
                end
            end

            -- Inserter held items
            if etype == "inserter" then
                local ok, ins_err = pcall(function()
                    local held = InventoryScanner.extract_inserter_held_item(entity)
                    if held then
                        local key = Util.make_quality_key(held.name, held.quality or Util.QUALITY_NORMAL)
                        item_totals[key] = (item_totals[key] or 0) + held.count
                        total = total + held.count
                    end
                end)

                if not ok then
                    log(string.format("[SurfaceCounter] Error counting inserter held item for entity %s: %s", entity.name, ins_err))
                end
            end
        end
    end

    -- Ground items
    local ground_items = surface.find_entities_filtered({type = "item-entity"})
    for _, item_entity in ipairs(ground_items) do
        if item_entity.valid and item_entity.stack and item_entity.stack.valid_for_read then
            local stack = item_entity.stack
            local key = Util.make_quality_key(stack.name, (stack.quality and stack.quality.name) or Util.QUALITY_NORMAL)
            item_totals[key] = (item_totals[key] or 0) + stack.count
            total = total + stack.count
        end
    end

    return item_totals, total
end

--- Count all fluids on a live surface using segment-aware reading
--- CRITICAL (Factorio 2.0): After writing segment totals, entity.fluidbox[i] returns
--- local buffer amounts that haven't redistributed yet. get_fluid_segment_contents()
--- returns the true segment total regardless of redistribution state.
--- @param surface LuaSurface: The surface to count fluids on
--- @return table, number: fluid_key→amount map, total fluid amount
function SurfaceCounter.count_fluids(surface)
    if not surface or not surface.valid then
        return {}, 0
    end

    local fluid_totals = {}
    local total = 0
    local counted_segments = {}
    local known_fluid_temps = {}

    local entities = surface.find_entities_filtered({})

    -- First pass: collect known temperatures from entities with non-empty local fluidboxes
    for _, entity in ipairs(entities) do
        if entity.valid and entity.fluidbox then
            pcall(function()
                for i = 1, #entity.fluidbox do
                    local fluid = entity.fluidbox[i]
                    if fluid and fluid.name and fluid.temperature then
                        known_fluid_temps[fluid.name] = fluid.temperature
                    end
                end
            end)
        end
    end

    -- Second pass: count using segment contents (deduplicating by segment ID)
    for _, entity in ipairs(entities) do
        if entity.valid and entity.fluidbox then
            local success, err = pcall(function()
                for i = 1, #entity.fluidbox do
                    local seg_id = entity.fluidbox.get_fluid_segment_id(i)
                    if seg_id and not counted_segments[seg_id] then
                        -- New segment: count using segment contents
                        counted_segments[seg_id] = true
                        local contents = entity.fluidbox.get_fluid_segment_contents(i)
                        if contents then
                            for fluid_name, amount in pairs(contents) do
                                local local_fluid = entity.fluidbox[i]
                                local temp = (local_fluid and local_fluid.temperature) or known_fluid_temps[fluid_name] or 15
                                local key = Util.make_fluid_temp_key(fluid_name, temp)
                                fluid_totals[key] = (fluid_totals[key] or 0) + amount
                                total = total + amount
                            end
                        end
                    elseif not seg_id then
                        -- Isolated fluidbox: use local amount
                        local fluid = entity.fluidbox[i]
                        if fluid and fluid.name then
                            local key = Util.make_fluid_temp_key(fluid.name, fluid.temperature)
                            fluid_totals[key] = (fluid_totals[key] or 0) + fluid.amount
                            total = total + fluid.amount
                        end
                    end
                    -- Already counted segments: skip
                end
            end)

            if not success then
                log(string.format("[SurfaceCounter] Error counting fluids for entity %s: %s", entity.name, err))
            end
        end
    end

    return fluid_totals, total
end

--- Count both items and fluids on a live surface
--- Convenience wrapper that calls count_items and count_fluids.
--- @param surface LuaSurface: The surface to count
--- @return table: { item_counts, item_total, fluid_counts, fluid_total }
function SurfaceCounter.count_all(surface)
    local item_counts, item_total = SurfaceCounter.count_items(surface)
    local fluid_counts, fluid_total = SurfaceCounter.count_fluids(surface)
    return {
        item_counts = item_counts,
        item_total = item_total,
        fluid_counts = fluid_counts,
        fluid_total = fluid_total,
    }
end

return SurfaceCounter
