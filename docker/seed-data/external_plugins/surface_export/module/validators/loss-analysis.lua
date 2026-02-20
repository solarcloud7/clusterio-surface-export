-- FactorioSurfaceExport - Loss Analysis
-- Post-activation loss analysis for platform transfers.
-- Extracted from async-processor.lua complete_import_job.

local Util = require("modules/surface_export/utils/util")
local GameUtils = require("modules/surface_export/utils/game-utils")
local InventoryScanner = require("modules/surface_export/export_scanners/inventory-scanner")
local SurfaceCounter = require("modules/surface_export/validators/surface-counter")

local LossAnalysis = {}

--- Reconcile high-temperature fluid counts between expected and actual.
--- At extreme temps (>10,000°C), the engine may merge packets via weighted-average
--- temperature, shifting fluid between temperature keys while preserving total volume.
--- This function aggregates by base fluid name for high-temp, and compares per-key for low-temp.
--- @param expected_counts table: fluid_key → amount (from source verification)
--- @param actual_counts table: fluid_key → amount (from live surface)
--- @param high_temp_threshold number|nil: Temperature threshold (default: Util.HIGH_TEMP_THRESHOLD)
--- @return table: Reconciliation result with fields:
---   reconciledLoss, lowTempLoss, highTempReconciledLoss,
---   expectedHighTemp, actualHighTemp, allHighTempNames,
---   totalExpected, totalActual, rawDelta, fluidPreservedPct
function LossAnalysis.reconcile_fluids(expected_counts, actual_counts, high_temp_threshold)
    local HIGH_TEMP = high_temp_threshold or Util.HIGH_TEMP_THRESHOLD

    -- Aggregate high-temp fluids by base name
    local expected_ht_by_name = {}
    local actual_ht_by_name = {}
    for key, amt in pairs(expected_counts or {}) do
        local name, temp = Util.parse_fluid_temp_key(key)
        if temp >= HIGH_TEMP then
            expected_ht_by_name[name] = (expected_ht_by_name[name] or 0) + amt
        end
    end
    for key, amt in pairs(actual_counts or {}) do
        local name, temp = Util.parse_fluid_temp_key(key)
        if temp >= HIGH_TEMP then
            actual_ht_by_name[name] = (actual_ht_by_name[name] or 0) + amt
        end
    end

    -- Reconciled loss for high-temp: aggregate comparison
    local ht_loss = 0
    local all_ht_names = {}
    for n, _ in pairs(expected_ht_by_name) do all_ht_names[n] = true end
    for n, _ in pairs(actual_ht_by_name) do all_ht_names[n] = true end
    for name, _ in pairs(all_ht_names) do
        local exp = expected_ht_by_name[name] or 0
        local act = actual_ht_by_name[name] or 0
        ht_loss = ht_loss + math.max(0, exp - act)
    end

    -- Low-temp loss: straightforward per-key
    local lt_loss = 0
    for key, exp in pairs(expected_counts or {}) do
        local _, temp = Util.parse_fluid_temp_key(key)
        if temp < HIGH_TEMP then
            local act = (actual_counts or {})[key] or 0
            lt_loss = lt_loss + math.max(0, exp - act)
        end
    end

    local total_expected = Util.sum_fluids(expected_counts or {})
    local total_actual = Util.sum_fluids(actual_counts or {})
    local reconciled_loss = lt_loss + ht_loss

    -- Build high-temp aggregate details
    local ht_aggregates = {}
    for name, _ in pairs(all_ht_names) do
        local exp = expected_ht_by_name[name] or 0
        local act = actual_ht_by_name[name] or 0
        ht_aggregates[name] = {
            expected = exp,
            actual = act,
            delta = act - exp,
            reconciled = math.abs(exp - act) <= 1,
        }
    end

    return {
        reconciledLoss = reconciled_loss,
        lowTempLoss = lt_loss,
        highTempReconciledLoss = ht_loss,
        expectedHighTemp = expected_ht_by_name,
        actualHighTemp = actual_ht_by_name,
        allHighTempNames = all_ht_names,
        highTempAggregates = ht_aggregates,
        totalExpected = total_expected,
        totalActual = total_actual,
        rawDelta = total_expected - total_actual,
        fluidPreservedPct = total_expected > 0
            and ((total_expected - reconciled_loss) / total_expected * 100)
            or 100,
        highTempThreshold = HIGH_TEMP,
    }
end

--- Build per-entity-type expected item totals from serialized entity data
--- @param entities_to_create table: Array of serialized entity data
--- @return table: entity_type → total_item_count
local function build_expected_by_type(entities_to_create)
    local expected_by_type = {}
    for _, entity_data in ipairs(entities_to_create) do
        local etype = entity_data.type or entity_data.name or "unknown"
        if entity_data.specific_data then
            if entity_data.specific_data.inventories then
                for _, inv_data in ipairs(entity_data.specific_data.inventories) do
                    if inv_data.items then
                        for _, item in ipairs(inv_data.items) do
                            expected_by_type[etype] = (expected_by_type[etype] or 0) + item.count
                        end
                    end
                end
            end
            if entity_data.specific_data.items then
                for _, line_data in ipairs(entity_data.specific_data.items) do
                    if line_data.items then
                        for _, item in ipairs(line_data.items) do
                            expected_by_type[etype] = (expected_by_type[etype] or 0) + item.count
                        end
                    end
                end
            end
            if entity_data.specific_data.held_item then
                expected_by_type[etype] = (expected_by_type[etype] or 0) + entity_data.specific_data.held_item.count
            end
        end
    end
    return expected_by_type
end

--- Build per-entity-type actual item totals from a live surface
--- @param surface LuaSurface: The surface to scan
--- @return table: entity_type → total_item_count
local function build_actual_by_type(surface)
    local actual_by_type = {}
    local live_entities = surface.find_entities_filtered({})
    for _, entity in ipairs(live_entities) do
        if entity.valid then
            local etype = entity.type
            pcall(function()
                local invs = InventoryScanner.extract_all_inventories(entity)
                local inv_totals = InventoryScanner.count_all_items(invs)
                for _, count in pairs(inv_totals) do
                    actual_by_type[etype] = (actual_by_type[etype] or 0) + count
                end
            end)
            if GameUtils.BELT_ENTITY_TYPES[etype] then
                pcall(function()
                    local belt_lines = InventoryScanner.extract_belt_items(entity)
                    for _, line_data in ipairs(belt_lines) do
                        if line_data.items then
                            for _, item in ipairs(line_data.items) do
                                actual_by_type[etype] = (actual_by_type[etype] or 0) + item.count
                            end
                        end
                    end
                end)
            end
            if etype == "inserter" then
                pcall(function()
                    local held = InventoryScanner.extract_inserter_held_item(entity)
                    if held then
                        actual_by_type[etype] = (actual_by_type[etype] or 0) + held.count
                    end
                end)
            end
        end
    end
    return actual_by_type
end

--- Run post-activation loss analysis.
--- Counts live surface items/fluids, compares against expected verification data,
--- logs detailed breakdown, and updates the validation result in-place.
--- @param surface LuaSurface: The imported platform surface
--- @param entities_to_create table: Array of serialized entity data (for per-type breakdown)
--- @param validation_result table: The validation result to update (modified in-place)
function LossAnalysis.run(surface, entities_to_create, validation_result)
    local result = validation_result
    if not result.totalExpectedItems then
        return
    end

    -- === ITEM LOSS ANALYSIS ===
    local expected_by_type = build_expected_by_type(entities_to_create)

    -- Count all items and fluids on the live surface
    local surface_counts = SurfaceCounter.count_all(surface)
    local actual_item_counts = surface_counts.item_counts
    local total_actual_items = surface_counts.item_total
    local actual_fluid_counts = surface_counts.fluid_counts
    local total_actual_fluids = surface_counts.fluid_total

    -- Build per-entity-type actual counts for breakdown logging
    local actual_by_type = build_actual_by_type(surface)

    -- Log item loss analysis
    local total_expected = result.totalExpectedItems
    local total_loss = total_expected - total_actual_items
    if total_loss ~= 0 then
        log(string.format("[Loss Analysis] Post-activation item delta: %+d items (expected=%d, actual=%d, %.1f%% preserved)",
            -total_loss, total_expected, total_actual_items,
            total_expected > 0 and (total_actual_items / total_expected * 100) or 100))

        local all_types = {}
        for t, _ in pairs(expected_by_type) do all_types[t] = true end
        for t, _ in pairs(actual_by_type) do all_types[t] = true end

        for etype, _ in pairs(all_types) do
            local exp = expected_by_type[etype] or 0
            local act = actual_by_type[etype] or 0
            local diff = exp - act
            if diff ~= 0 then
                log(string.format("[Loss Analysis]   %-30s expected=%d actual=%d diff=%+d",
                    etype, exp, act, -diff))
            end
        end
    else
        log(string.format("[Loss Analysis] Post-activation: ZERO item loss (expected=%d, actual=%d)", total_expected, total_actual_items))
    end

    -- === FLUID LOSS ANALYSIS ===
    local recon = LossAnalysis.reconcile_fluids(result.expectedFluidCounts, actual_fluid_counts)

    if math.abs(recon.reconciledLoss) > 1 then
        log(string.format("[Loss Analysis] Post-activation fluid delta: %+.1f reconciled (raw %+.1f) (expected=%.1f, actual=%.1f, %.1f%% preserved)",
            -recon.reconciledLoss, -recon.rawDelta, recon.totalExpected, recon.totalActual, recon.fluidPreservedPct))

        -- Per-fluid breakdown (low-temp only, high-temp shown as aggregate)
        for fluid_key, _ in pairs(result.expectedFluidCounts or {}) do
            local _, temp = Util.parse_fluid_temp_key(fluid_key)
            if temp < recon.highTempThreshold then
                local exp = (result.expectedFluidCounts or {})[fluid_key] or 0
                local act = actual_fluid_counts[fluid_key] or 0
                local diff = exp - act
                if math.abs(diff) > 1 then
                    log(string.format("[Loss Analysis]   %-30s expected=%.1f actual=%.1f diff=%+.1f",
                        fluid_key, exp, act, -diff))
                end
            end
        end

        -- High-temp aggregate breakdown
        for name, _ in pairs(recon.allHighTempNames) do
            local exp = recon.expectedHighTemp[name] or 0
            local act = recon.actualHighTemp[name] or 0
            local diff = exp - act
            if math.abs(diff) > 1 then
                log(string.format("[Loss Analysis]   %-30s expected=%.1f actual=%.1f diff=%+.1f (high-temp aggregate)",
                    name, exp, act, -diff))
            else
                log(string.format("[Loss Analysis]   %-30s expected=%.1f actual=%.1f RECONCILED (temp-merged)",
                    name, exp, act))
            end
        end
    else
        log(string.format("[Loss Analysis] Post-activation: ZERO fluid loss (expected=%.1f, actual=%.1f)",
            recon.totalExpected, recon.totalActual))
        -- Still log high-temp reconciliation if raw numbers differ
        if math.abs(recon.rawDelta) > 1 then
            for name, _ in pairs(recon.allHighTempNames) do
                local exp = recon.expectedHighTemp[name] or 0
                local act = recon.actualHighTemp[name] or 0
                log(string.format("[Loss Analysis]   %-30s expected=%.1f actual=%.1f RECONCILED (temp-merged)",
                    name, exp, act))
            end
        end
    end

    -- === FAILED ENTITY LOSS REPORT ===
    if result.failedEntityLosses and result.failedEntityLosses.entity_count > 0 then
        local fel = result.failedEntityLosses
        log(string.format("[Loss Analysis] %d entities failed to place — %d items, %.1f fluids unrestorable (excluded from expected totals)",
            fel.entity_count, fel.total_items, fel.total_fluids))
        for _, ent in ipairs(fel.entities or {}) do
            if ent.items > 0 or ent.fluids > 0 then
                log(string.format("[Loss Analysis]   FAILED: %s (%s) at (%.1f,%.1f) — %d items, %.1f fluids",
                    ent.name, ent.type,
                    ent.position and (ent.position.x or ent.position[1]) or 0,
                    ent.position and (ent.position.y or ent.position[2]) or 0,
                    ent.items, ent.fluids))
            else
                log(string.format("[Loss Analysis]   FAILED: %s (%s) at (%.1f,%.1f) — no items or fluids",
                    ent.name, ent.type,
                    ent.position and (ent.position.x or ent.position[1]) or 0,
                    ent.position and (ent.position.y or ent.position[2]) or 0))
            end
        end
        if fel.entity_count > 50 then
            log(string.format("[Loss Analysis]   ... and %d more failed entities (detail capped at 50)", fel.entity_count - 50))
        end
    end

    -- === UPDATE VALIDATION RESULT with post-activation counts ===
    result.totalActualItems = total_actual_items
    result.actualItemCounts = actual_item_counts
    result.totalActualFluids = total_actual_fluids
    result.actualFluidCounts = actual_fluid_counts
    result.postActivation = true

    result.fluidReconciliation = {
        highTempThreshold = recon.highTempThreshold,
        rawFluidDelta = recon.rawDelta,
        reconciledFluidLoss = recon.reconciledLoss,
        lowTempLoss = recon.lowTempLoss,
        highTempReconciledLoss = recon.highTempReconciledLoss,
        fluidPreservedPct = recon.fluidPreservedPct,
        highTempAggregates = recon.highTempAggregates,
    }
end

return LossAnalysis
