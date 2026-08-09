local Verification = require("modules/surface_export/validators/verification")
local Util = require("modules/surface_export/utils/util")
local GameUtils = require("modules/surface_export/utils/game-utils")
local SurfaceCounter = require("modules/surface_export/validators/surface-counter")
local LossAnalysis = require("modules/surface_export/validators/loss-analysis")

local TransferValidation = {}

local EXACT_EPSILON = 1e-6

local function aggregate_fluid_counts_by_name(fluid_counts)
    local by_name = {}
    for fluid_key, volume in pairs(fluid_counts or {}) do
        local name, _ = Util.parse_fluid_temp_key(fluid_key)
        by_name[name] = (by_name[name] or 0) + (volume or 0)
    end
    return by_name
end

local function validate_fluid_counts(expected_fluid_counts, actual_fluid_counts, strict)
    local fluid_mismatches = {}
    local fluid_match = true
    local recon = LossAnalysis.reconcile_fluids(expected_fluid_counts, actual_fluid_counts)
    local expected_by_name = aggregate_fluid_counts_by_name(expected_fluid_counts)
    local actual_by_name = aggregate_fluid_counts_by_name(actual_fluid_counts)
    local all_names = {}

    for name, _ in pairs(expected_by_name) do
        all_names[name] = true
    end
    for name, _ in pairs(actual_by_name) do
        all_names[name] = true
    end

    for name, _ in pairs(all_names) do
        local expected_volume = expected_by_name[name] or 0
        local actual_volume = actual_by_name[name] or 0
        local delta = actual_volume - expected_volume

        if strict then
            if math.abs(delta) > EXACT_EPSILON then
                fluid_match = false
                local direction = delta > 0 and "GAINED" or "LOST"
                table.insert(fluid_mismatches, string.format(
                    "%s: %s fluid - expected %.6f, got %.6f (delta %.6f)",
                    name, direction, expected_volume, actual_volume, delta
                ))
            end
        elseif delta > 500 then
            fluid_match = false
            table.insert(fluid_mismatches, string.format(
                "%s: GAINED fluid - expected %.1f, got %.1f", name, expected_volume, actual_volume
            ))
        elseif -delta > math.max(25, math.min(500, expected_volume * 0.05)) then
            fluid_match = false
            table.insert(fluid_mismatches, string.format(
                "%s: LOST fluid - expected %.1f, got %.1f", name, expected_volume, actual_volume
            ))
        elseif (recon.allHighTempNames or {})[name] then
            log(string.format("[TransferValidation] Fluid %s: expected=%.1f actual=%.1f (name-aggregate reconciled)",
                name, expected_volume, actual_volume))
        end
    end

    return fluid_match, fluid_mismatches, recon
end

function TransferValidation.validate_import(surface, expected_verification, options)
    options = options or {}
    if not surface or not surface.valid then
        return false, {
            itemCountMatch = false,
            fluidCountMatch = false,
            entityCount = 0,
            mismatchDetails = "Surface not valid"
        }
    end

    local STORAGE_ENTITY_TYPES = {
        ["container"] = true,
        ["logistic-container"] = true,
        ["cargo-wagon"] = true,
        ["car"] = true,
        ["spider-vehicle"] = true,
        ["cargo-landing-pad"] = true,
        ["cargo-bay"] = true,
        ["rocket-silo"] = true,
    }
    
    local CONSUMER_ENTITY_TYPES = {
        ["assembling-machine"] = true,
        ["furnace"] = true,
        ["mining-drill"] = true,
        ["lab"] = true,
        ["reactor"] = true,
        ["boiler"] = true,
        ["burner-generator"] = true,
        ["generator"] = true,
        ["agricultural-tower"] = true,
        ["rocket-silo"] = true,
    }

    local entities = surface.find_entities_filtered({})
    
    local storage_item_counts = {}
    local consumer_item_counts = {}
    local total_item_counts = {}
    
    local entity_type_counts = {}

    for _, entity in ipairs(entities) do
        if entity.valid then
            local entity_name = entity.name
            entity_type_counts[entity_name] = (entity_type_counts[entity_name] or 0) + 1
            local entity_type = entity.type
            local is_storage = STORAGE_ENTITY_TYPES[entity_type]
            local is_consumer = CONSUMER_ENTITY_TYPES[entity_type]

            for key, count in pairs(SurfaceCounter.count_entity_items(entity, "inventories")) do
                total_item_counts[key] = (total_item_counts[key] or 0) + count
                if is_storage then
                    storage_item_counts[key] = (storage_item_counts[key] or 0) + count
                elseif is_consumer then
                    consumer_item_counts[key] = (consumer_item_counts[key] or 0) + count
                end
            end

            if GameUtils.BELT_ENTITY_TYPES[entity_type] then
                for key, count in pairs(SurfaceCounter.count_entity_items(entity, "belts")) do
                    total_item_counts[key] = (total_item_counts[key] or 0) + count
                    storage_item_counts[key] = (storage_item_counts[key] or 0) + count
                end
            end
            if entity_type == "inserter" then
                for key, count in pairs(SurfaceCounter.count_entity_items(entity, "held")) do
                    total_item_counts[key] = (total_item_counts[key] or 0) + count
                    storage_item_counts[key] = (storage_item_counts[key] or 0) + count
                end
            end
        end
    end

    local ground_totals = SurfaceCounter.count_ground_items(surface)
    for key, count in pairs(ground_totals) do
        total_item_counts[key] = (total_item_counts[key] or 0) + count
        storage_item_counts[key] = (storage_item_counts[key] or 0) + count
    end

    local strict = options.strict == true
    local actual_fluid_counts = SurfaceCounter.count_fluids(surface, options.segment_temps)

    
    local item_mismatches = {}
    local item_match = true
    
    local STORAGE_TOLERANCE = 5
    local TOTAL_LOSS_TOLERANCE = 0.95
    local MIN_ABSOLUTE_LOSS = 100

    for item_name, expected_count in pairs(expected_verification.item_counts or {}) do
        local actual_count = total_item_counts[item_name] or 0
        local diff = expected_count - actual_count

        if strict then
            if actual_count > expected_count then
                item_match = false
                table.insert(item_mismatches, string.format(
                    "%s: GAINED items - expected %d, got %d",
                    item_name, expected_count, actual_count
                ))
            elseif diff > 0 then
                item_match = false
                table.insert(item_mismatches, string.format(
                    "%s: loss - expected %d, got %d (lost %d)",
                    item_name, expected_count, actual_count, diff
                ))
            end
        else
            if actual_count > expected_count + STORAGE_TOLERANCE then
                item_match = false
                table.insert(item_mismatches, string.format(
                    "%s: GAINED items - expected %d, got %d",
                    item_name, expected_count, actual_count
                ))
            elseif diff > expected_count * TOTAL_LOSS_TOLERANCE and diff > MIN_ABSOLUTE_LOSS then
                item_match = false
                table.insert(item_mismatches, string.format(
                    "%s: excessive loss - expected %d, got %d (lost %d, %.0f%%)",
                    item_name, expected_count, actual_count, diff, (diff/expected_count)*100
                ))
            end
        end
    end

    for item_name, actual_count in pairs(total_item_counts) do
        if not expected_verification.item_counts[item_name] then
            if strict or actual_count > 20 then
                item_match = false
                table.insert(item_mismatches, string.format(
                    "%s: unexpected item (got %d)",
                    item_name, actual_count
                ))
            end
        end
    end

    local fluid_mismatches = {}
    local fluid_match, fluid_reconciliation = true, nil
    fluid_match, fluid_mismatches, fluid_reconciliation = validate_fluid_counts(
        expected_verification.fluid_counts or {}, actual_fluid_counts or {}, strict)

    local mismatch_details = nil
    if not item_match or not fluid_match then
        local details_parts = {}

        if not item_match then
            table.insert(details_parts, "Item mismatches: " .. table.concat(item_mismatches, "; "))
        end

        if not fluid_match then
            table.insert(details_parts, "Fluid mismatches: " .. table.concat(fluid_mismatches, "; "))
        end

        mismatch_details = table.concat(details_parts, " | ")
    end

    local total_expected_items = Util.sum_items(expected_verification.item_counts or {})
    local total_actual_items = Util.sum_items(total_item_counts)
    local total_expected_fluids = Util.sum_fluids(expected_verification.fluid_counts or {})
    local total_actual_fluids = Util.sum_fluids(actual_fluid_counts)

    local item_loss_by_type = {}
    local total_item_loss = 0
    for item_name, exp in pairs(expected_verification.item_counts or {}) do
        local act = total_item_counts[item_name] or 0
        if exp > act then
            item_loss_by_type[item_name] = { expected = exp, actual = act, loss = exp - act }
            total_item_loss = total_item_loss + (exp - act)
        end
    end

    local validation_result = {
        itemCountMatch = item_match,
        fluidCountMatch = fluid_match,
        entityCount = #entities,
        mismatchDetails = mismatch_details,
        expectedItemCounts = expected_verification.item_counts or {},
        actualItemCounts = total_item_counts,
        expectedFluidCounts = expected_verification.fluid_counts or {},
        actualFluidCounts = actual_fluid_counts,
        entityTypeBreakdown = entity_type_counts,
        itemTypesExpected = table_size(expected_verification.item_counts or {}),
        itemTypesActual = table_size(total_item_counts),
        fluidTypesExpected = table_size(expected_verification.fluid_counts or {}),
        fluidTypesActual = table_size(actual_fluid_counts),
        totalExpectedItems = total_expected_items,
        totalActualItems = total_actual_items,
        totalExpectedFluids = total_expected_fluids,
        totalActualFluids = total_actual_fluids,
        itemLossByType = item_loss_by_type,
        totalItemLoss = total_item_loss,
        fluidReconciliation = fluid_reconciliation,
    }

    local success = item_match and fluid_match
    validation_result.success = success
    if not item_match then
        validation_result.failedStage = "items"
    elseif not fluid_match then
        validation_result.failedStage = "fluids"
    end

    if total_item_loss > 0 then
        log(string.format("[TransferValidation] FIDELITY: %d item(s) short across %d type(s) (gate may tolerate; see itemLossByType)",
            total_item_loss, table_size(item_loss_by_type)))
    end

    if success then
        log(string.format("[TransferValidation] ✓ Validation passed: %d entities, %d item types, %d fluid types",
            #entities,
            table_size(total_item_counts),
            table_size(actual_fluid_counts)
        ))
    else
        log(string.format("[TransferValidation] ✗ Validation failed: %s", mismatch_details))
    end

    return success, validation_result
end

function TransferValidation.store_validation_result(result_id, validation_result)
    if type(result_id) ~= "string" or result_id == "" then
        return false, "result_id is required"
    end
    if not storage.validation_results then
        storage.validation_results = {}
    end

    storage.validation_results[result_id] = {
        result = validation_result,
        timestamp = game.tick
    }
    return true
end

function TransferValidation.clear_validation_result(result_id)
    if storage.validation_results and type(result_id) == "string" then
        storage.validation_results[result_id] = nil
    end
end

function TransferValidation.get_validation_result(result_id)
    if type(result_id) ~= "string" or result_id == "" then
        error("validation result id is required")
    end
    if not storage.validation_results then
        return nil
    end

    local stored = storage.validation_results[result_id]
    if stored then
        return stored.result
    end

    return nil
end

function TransferValidation.cleanup_old_results(max_age_ticks)
    if not storage.validation_results then
        return
    end

    max_age_ticks = max_age_ticks or 36000

    for result_id, stored in pairs(storage.validation_results) do
        local age = game.tick - stored.timestamp
        if age > max_age_ticks then
            storage.validation_results[result_id] = nil
        end
    end
end

return TransferValidation
