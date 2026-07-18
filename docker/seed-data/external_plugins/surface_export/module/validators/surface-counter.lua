-- FactorioSurfaceExport - Surface Counter
-- Unified live-surface counting for items and fluids.
-- Single source of truth used by verification, transfer-validation, and loss analysis.

local InventoryScanner = require("modules/surface_export/export_scanners/inventory-scanner")
local GameUtils = require("modules/surface_export/utils/game-utils")
local Util = require("modules/surface_export/utils/util")
local FluidOwnership = require("modules/surface_export/utils/fluid-ownership")

local SurfaceCounter = {}

--- Count all items held by a SINGLE entity.
--- Pure per-entity meter with no cross-entity state: scans indexed inventories (aliased
--- defines already deduplicated by InventoryScanner), belt transport lines, and the
--- inserter held stack. Preserves the pcall-with-logged-error pattern so one unreadable
--- entity cannot abort a surface-wide census (the pcall-logging lint guard forbids a
--- silent swallow). Independent of the export-side entity-handler dispatch by design.
--- @param entity LuaEntity: The entity to count items for
--- @return table: quality_key→count map for this entity (empty if invalid)
function SurfaceCounter.count_entity_items(entity)
    local totals = {}
    if not entity or not entity.valid then
        return totals
    end

    local etype = entity.type

    -- Inventory items (pcall-protected: some entities may not support inventory access)
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

    -- Belt items
    if GameUtils.BELT_ENTITY_TYPES[etype] then
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

    -- Inserter held items
    if etype == "inserter" then
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

    return totals
end

--- Count all items on a live surface
--- Folds count_entity_items over every entity, then adds the ground-item pass.
--- Behavior-identical to the previous inline scan (item counts are integers, so the
--- per-entity fold is exact regardless of grouping); the destination transfer gate
--- consumes this map, so its readings must not change.
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

--- Count all fluids held by a SINGLE entity (segment-aware second pass).
--- CRITICAL (Factorio 2.0): After writing segment totals, entity.fluidbox[i] returns
--- local buffer amounts that haven't redistributed yet. get_fluid_segment_contents()
--- returns the true segment total regardless of redistribution state.
--- Segment dedup is inherently CROSS-ENTITY: a fluid segment spans multiple entities and
--- must be counted exactly once across a full surface fold. That shared state therefore
--- lives in a caller-owned `state` table (NOT in this function), so the caller builds it
--- once and passes the SAME table for every entity — mirroring the previous single-loop
--- behavior exactly. This function READS and MUTATES `state.counted_segments`.
--- Preserves the pcall-with-logged-error pattern (the pcall-logging lint guard forbids a
--- silent swallow). Independent of the export-side entity-handler dispatch by design.
--- @param entity LuaEntity: The entity to count fluids for
--- @param exclude_engine_owned boolean|nil: Exclude engine-owned isolated boxes (strict transfer validation)
--- @param state table: Shared cross-entity fold state, built once by count_fluids:
---   state.counted_segments      seg_id set already counted (read AND mutated here — the dedup memory)
---   state.known_fluid_temps      fluid_name→temp fallback (from count_fluids' first pass)
---   state.seg_temps              authoritative seg_id→{fluid,temp} from FluidRestoration.restore()
---   state.engine_owned_segments  seg_id set skipped when exclude_engine_owned is set
--- @return table: fluid_key→amount map contributed by this entity (empty if invalid / no fluidbox)
function SurfaceCounter.count_entity_fluids(entity, exclude_engine_owned, state)
    local totals = {}
    if not entity or not entity.valid or not entity.fluidbox then
        return totals
    end

    local counted_segments = state.counted_segments
    local known_fluid_temps = state.known_fluid_temps
    local seg_temps = state.seg_temps
    local engine_owned_segments = state.engine_owned_segments

    -- Count using segment contents (deduplicating by segment ID via the shared state).
    -- Temperature priority: seg_temps (authoritative) > local proxy > known_fluid_temps > 15
    local success, err = pcall(function()
        for i = 1, #entity.fluidbox do
            local seg_id = entity.fluidbox.get_fluid_segment_id(i)
            if seg_id and not counted_segments[seg_id] then
                counted_segments[seg_id] = true
                -- Engine-owned exclusion: seeded set authoritative (set-identity with the serializer's
                -- pre-pass) PLUS on-the-fly introducing-box classification so a hand-built state can't
                -- silently disable it (phantom fusion-plasma abort 2026-07-17; sound since non-default
                -- category segments only span engine-owned boxes — refines Pitfall #22, activatable
                -- entities expose no own segment ID; see api-notes).
                local engine_owned = engine_owned_segments[seg_id]
                    or (exclude_engine_owned and FluidOwnership.is_engine_owned_box(entity, i))
                -- Buffer-class-aware segment read via the ONE shared accessor, keeping the census
                -- read-identical with the serializer (paired-reads commensurability).
                local contents = not engine_owned
                    and FluidOwnership.effective_segment_contents(entity.fluidbox, i) or nil
                if contents then
                    for fluid_name, amount in pairs(contents) do
                        local temp
                        local st = seg_temps[seg_id]
                        if st and st.fluid == fluid_name then
                            temp = st.temp
                        else
                            local local_fluid = entity.fluidbox[i]
                            temp = (local_fluid and local_fluid.temperature) or known_fluid_temps[fluid_name] or 15
                        end
                        local key = Util.make_fluid_temp_key(fluid_name, temp)
                        totals[key] = (totals[key] or 0) + amount
                    end
                end
            elseif not seg_id and not (exclude_engine_owned and FluidOwnership.is_engine_owned_box(entity, i)) then
                -- Isolated fluidbox: use local amount
                local fluid = entity.fluidbox[i]
                if fluid and fluid.name then
                    local key = Util.make_fluid_temp_key(fluid.name, fluid.temperature)
                    totals[key] = (totals[key] or 0) + fluid.amount
                end
            end
            -- Already counted segments: skip
        end
    end)

    if not success then
        log(string.format("[SurfaceCounter] Error counting fluids for entity %s: %s", entity.name, err))
    end

    return totals
end

--- Count all fluids on a live surface using segment-aware reading.
--- Folds count_entity_fluids over every entity, sharing one cross-entity `state` (so a
--- segment spanning entities is counted once). The known-temperature first pass MUST run
--- to completion before the fold — an entity counted early relies on temperatures a later
--- entity contributes — so it stays a separate full pass, exactly as before.
--- @param surface LuaSurface: The surface to count fluids on
--- @param segment_temps table|nil: Optional seg_id→{fluid,temp} map from FluidRestoration.restore()
--- @param exclude_engine_owned boolean|nil: Exclude non-default-category segments for strict transfer validation
--- @return table, number: fluid_key→amount map, total fluid amount
function SurfaceCounter.count_fluids(surface, segment_temps, exclude_engine_owned)
    if not surface or not surface.valid then
        return {}, 0
    end

    local fluid_totals = {}
    local total = 0

    local entities = surface.find_entities_filtered({})

    local state = {
        counted_segments = {},
        known_fluid_temps = {},
        seg_temps = segment_temps or {},
        engine_owned_segments =
            exclude_engine_owned and FluidOwnership.collect_engine_owned_segments(entities) or {},
    }

    -- First pass: collect known temperatures from entities with non-empty local fluidboxes.
    -- This is a fallback for segments not covered by segment_temps.
    for _, entity in ipairs(entities) do
        if entity.valid and entity.fluidbox then
            Util.pcall_warn("[SurfaceCounter] Fluidbox temp read on " .. entity.name, function()
                for i = 1, #entity.fluidbox do
                    local fluid = entity.fluidbox[i]
                    if fluid and fluid.name and fluid.temperature then
                        state.known_fluid_temps[fluid.name] = fluid.temperature
                    end
                end
            end)
        end
    end

    -- Second pass: fold the per-entity fluid meter, deduplicating by segment ID via state.
    for _, entity in ipairs(entities) do
        if entity.valid and entity.fluidbox then
            local entity_totals = SurfaceCounter.count_entity_fluids(entity, exclude_engine_owned, state)
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
