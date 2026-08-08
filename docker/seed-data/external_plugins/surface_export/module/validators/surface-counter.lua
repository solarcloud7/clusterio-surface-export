-- FactorioSurfaceExport - Surface Counter
-- Live-surface counting for items and fluids.

local InventoryScanner = require("modules/surface_export/export_scanners/inventory-scanner")
local GameUtils = require("modules/surface_export/utils/game-utils")
local Util = require("modules/surface_export/utils/util")

local SurfaceCounter = {}

--- Count loose item-entity stacks on a surface.
--- @param surface LuaSurface
--- @return table, number: quality_key→count map, total
function SurfaceCounter.count_ground_items(surface)
    local totals = {}
    local total = 0
    if not surface or not surface.valid then
        return totals, total
    end
    -- One ground-stack reader: the meter's explicit "ground" subject. A second inline read here
    -- would be the duplicate-drift class this file was unified to delete.
    for _, item_entity in ipairs(surface.find_entities_filtered({type = "item-entity"})) do
        for key, count in pairs(SurfaceCounter.count_entity_items(item_entity, "ground")) do
            totals[key] = (totals[key] or 0) + count
            total = total + count
        end
    end
    return totals, total
end

--- Count items held by a SINGLE entity, optionally restricted to one subject.
--- subject nil = inventories + belts + held (the default read); "inventories" | "belts" | "held"
--- select one block; "ground" reads a loose item-entity stack and is counted ONLY under this
--- explicit subject — the nil default excludes it.
--- @param entity LuaEntity
--- @param subject string|nil
--- @return table: quality_key→count map for this entity (empty if invalid)
function SurfaceCounter.count_entity_items(entity, subject)
    local totals = {}
    if not entity or not entity.valid then
        return totals
    end

    local etype = entity.type

    if subject == nil or subject == "inventories" then
        local success, err = pcall(function()
            local inventories = InventoryScanner.extract_all_inventories(entity)
            local inv_totals = InventoryScanner.count_all_items(inventories)
            for key, count in pairs(inv_totals) do
                totals[key] = (totals[key] or 0) + count
            end
        end)

        if not success then
            log(string.format("[SurfaceCounter] Error counting inventories for entity %s: %s", entity.name, err))
        end
    end

    if (subject == nil or subject == "belts") and GameUtils.BELT_ENTITY_TYPES[etype] then
        local ok, belt_err = pcall(function()
            local belt_lines = InventoryScanner.extract_belt_items(entity)
            for _, line_data in ipairs(belt_lines) do
                if line_data.items then
                    for _, item in ipairs(line_data.items) do
                        local key = Util.make_quality_key(item.name, item.quality or Util.QUALITY_NORMAL)
                        totals[key] = (totals[key] or 0) + item.count
                    end
                end
            end
        end)

        if not ok then
            log(string.format("[SurfaceCounter] Error counting belt items for entity %s: %s", entity.name, belt_err))
        end
    end

    if (subject == nil or subject == "held") and etype == "inserter" then
        local ok, ins_err = pcall(function()
            local held = InventoryScanner.extract_inserter_held_item(entity)
            if held then
                local key = Util.make_quality_key(held.name, held.quality or Util.QUALITY_NORMAL)
                totals[key] = (totals[key] or 0) + held.count
            end
        end)

        if not ok then
            log(string.format("[SurfaceCounter] Error counting inserter held item for entity %s: %s", entity.name, ins_err))
        end
    end

    if subject == "ground" and etype == "item-entity" then
        local ok, ground_err = pcall(function()
            local stack = entity.stack
            if stack and stack.valid_for_read then
                local key = Util.make_quality_key(stack.name, (stack.quality and stack.quality.name) or Util.QUALITY_NORMAL)
                totals[key] = (totals[key] or 0) + stack.count
            end
        end)

        if not ok then
            log(string.format("[SurfaceCounter] Error counting ground item %s: %s", entity.name, ground_err))
        end
    end

    return totals
end

--- Count all items on a live surface: fold of count_entity_items plus the ground pass.
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
            local entity_totals = SurfaceCounter.count_entity_items(entity)
            for key, count in pairs(entity_totals) do
                item_totals[key] = (item_totals[key] or 0) + count
                total = total + count
            end
        end
    end

    local ground_totals, ground_total = SurfaceCounter.count_ground_items(surface)
    for key, count in pairs(ground_totals) do
        item_totals[key] = (item_totals[key] or 0) + count
    end
    total = total + ground_total

    return item_totals, total
end

--- Count all fluids held by a SINGLE entity (2.1 fluid API, segment-deduplicated).
--- [empirical, 2.1.11, fluid-law experiments 2026-07-21]: get_fluid_segment_fluid(i) returns the
--- EXACT segment total from any member box at any instant (the 2.0 buffer/window duality and the
--- order-dependent claim bug are gone at 2.1), so counting a segment ONCE from whichever member
--- the fold sees first is exact by construction. Segmentless boxes (machine buffers, fusion
--- generators) are counted from their own storage via get_fluid(i). Segment getters THROW on
--- segmentless boxes at 2.1 — has_fluid_segment(i) guards them.
--- Segment dedup is inherently CROSS-ENTITY, so the dedup memory lives in the caller-owned
--- `state` table passed to every entity of one fold.
--- Preserves the pcall-with-logged-error pattern (the pcall-logging lint guard forbids a
--- silent swallow). Independent of the export-side entity-handler dispatch by design.
--- @param entity LuaEntity: The entity to count fluids for
--- @param state table: Shared cross-entity fold state, built once by count_fluids:
---   state.counted_segments  seg_id set already counted (read AND mutated here — the dedup memory)
---   state.seg_temps         authoritative seg_id→{fluid,temp} from FluidRestoration.restore()
--- @return table: fluid_key→amount map contributed by this entity (empty if invalid / no storages)
function SurfaceCounter.count_entity_fluids(entity, state)
    local totals = {}
    if not entity or not entity.valid then
        return totals
    end

    local counted_segments = state.counted_segments
    local seg_temps = state.seg_temps or {}

    local success, err = pcall(function()
        local count = entity.fluids_count
        if not count or count == 0 then
            return
        end
        for i = 1, count do
            if entity.has_fluid_segment(i) then
                local seg_id = entity.get_fluid_segment_id(i)
                if seg_id and not counted_segments[seg_id] then
                    counted_segments[seg_id] = true
                    local seg_fluid = entity.get_fluid_segment_fluid(i)
                    if seg_fluid and seg_fluid.name and (seg_fluid.amount or 0) > 0 then
                        local temp
                        local st = seg_temps[seg_id]
                        if st and st.fluid == seg_fluid.name then
                            temp = st.temp
                        else
                            temp = seg_fluid.temperature or 15
                        end
                        local key = Util.make_fluid_temp_key(seg_fluid.name, temp)
                        totals[key] = (totals[key] or 0) + seg_fluid.amount
                    end
                end
                -- Already-counted segments: skip (exact by construction — every member reports
                -- the same total).
            else
                -- Segmentless storage: the entity's own content is the whole truth for this box.
                local fluid = entity.get_fluid(i)
                if fluid and fluid.name and (fluid.amount or 0) > 0 then
                    local key = Util.make_fluid_temp_key(fluid.name, fluid.temperature or 15)
                    totals[key] = (totals[key] or 0) + fluid.amount
                end
            end
        end
    end)

    if not success then
        log(string.format("[SurfaceCounter] Error counting fluids for entity %s: %s", entity.name, err))
    end

    return totals
end

--- Count all fluids on a live surface (2.1 segment reads).
--- Folds count_entity_fluids over every entity, sharing one cross-entity `state` so each
--- segment is counted exactly once. Segment reads carry their own temperature, so the old
--- known-temperature pre-pass is gone.
--- @param surface LuaSurface: The surface to count fluids on
--- @param segment_temps table|nil: Optional seg_id→{fluid,temp} map from FluidRestoration.restore()
--- @return table, number: fluid_key→amount map, total fluid amount
function SurfaceCounter.count_fluids(surface, segment_temps)
    if not surface or not surface.valid then
        return {}, 0
    end

    local fluid_totals = {}
    local total = 0

    local entities = surface.find_entities_filtered({})

    local state = {
        counted_segments = {},
        seg_temps = segment_temps or {},
    }

    for _, entity in ipairs(entities) do
        if entity.valid then
            local entity_totals = SurfaceCounter.count_entity_fluids(entity, state)
            for key, amount in pairs(entity_totals) do
                fluid_totals[key] = (fluid_totals[key] or 0) + amount
                total = total + amount
            end
        end
    end

    return fluid_totals, total
end

--- Count both items and fluids on a live surface
--- Convenience wrapper that calls count_items and count_fluids.
--- @param surface LuaSurface: The surface to count
--- @param segment_temps table|nil: Optional seg_id→{fluid,temp} map from FluidRestoration.restore()
--- @return table: { item_counts, item_total, fluid_counts, fluid_total }
function SurfaceCounter.count_all(surface, segment_temps)
    local item_counts, item_total = SurfaceCounter.count_items(surface)
    local fluid_counts, fluid_total = SurfaceCounter.count_fluids(surface, segment_temps)
    return {
        item_counts = item_counts,
        item_total = item_total,
        fluid_counts = fluid_counts,
        fluid_total = fluid_total,
    }
end

return SurfaceCounter
