-- FactorioSurfaceExport - Transfer Validation
-- Validates imported platforms against source verification data

local Verification = require("modules/surface_export/validators/verification")
local InventoryScanner = require("modules/surface_export/export_scanners/inventory-scanner")
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

--- Validate an imported platform against expected verification data
--- Uses grouped validation: strict for storage, lenient for machines
--- @param surface LuaSurface: The imported platform surface
--- @param expected_verification table: Expected item/fluid counts from source
--- @param options table|nil: Optional settings { strict = boolean, segment_temps = table }
--- @return boolean, table: success, validation_result
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

    -- Entity types that are pure storage (strict validation)
    local STORAGE_ENTITY_TYPES = {
        ["container"] = true,
        ["logistic-container"] = true,
        ["cargo-wagon"] = true,
        ["car"] = true,
        ["spider-vehicle"] = true,
        ["cargo-landing-pad"] = true,
        ["cargo-bay"] = true,        -- Space platform cargo
        ["rocket-silo"] = true,      -- Has rocket inventory
    }
    
    -- Entity types that consume/process items (lenient validation)
    local CONSUMER_ENTITY_TYPES = {
        ["assembling-machine"] = true,  -- Includes foundry
        ["furnace"] = true,
        ["mining-drill"] = true,
        ["lab"] = true,
        ["reactor"] = true,
        ["boiler"] = true,
        ["burner-generator"] = true,
        ["generator"] = true,
        ["agricultural-tower"] = true,
        ["rocket-silo"] = true,  -- Also processes items
    }

    -- Get all entities on imported surface
    local entities = surface.find_entities_filtered({})
    
    -- Count items separately for storage vs consumer entities
    local storage_item_counts = {}
    local consumer_item_counts = {}
    local total_item_counts = {}
    
    -- Track entity name breakdown for detailed stats.
    -- Uses entity.name (prototype name, e.g. "small-lamp") not entity.type (base type, e.g. "lamp")
    -- so the web UI can resolve CSS spritesheet classes like entity-small-lamp correctly.
    local entity_type_counts = {}

    for _, entity in ipairs(entities) do
        if entity.valid then
            local entity_name = entity.name
            entity_type_counts[entity_name] = (entity_type_counts[entity_name] or 0) + 1
            local entity_type = entity.type
            local is_storage = STORAGE_ENTITY_TYPES[entity_type]
            local is_consumer = CONSUMER_ENTITY_TYPES[entity_type]
            
            -- Count items in this entity's inventories
            local success, err = pcall(function()
                local inventories = InventoryScanner.extract_all_inventories(entity)
                local inv_totals = InventoryScanner.count_all_items(inventories)
                
                for key, count in pairs(inv_totals) do
                    total_item_counts[key] = (total_item_counts[key] or 0) + count
                    
                    if is_storage then
                        storage_item_counts[key] = (storage_item_counts[key] or 0) + count
                    elseif is_consumer then
                        consumer_item_counts[key] = (consumer_item_counts[key] or 0) + count
                    end
                end
            end)
            
            if not success then
                log(string.format("[TransferValidation] Error counting inventories for entity %s: %s", entity_name, err))
            end

            -- Count belt items
            if GameUtils.BELT_ENTITY_TYPES[entity_type] then
                Util.pcall_warn("[TransferValidation] Belt scan on " .. entity_name, function()
                    local belt_lines = InventoryScanner.extract_belt_items(entity)
                    for _, line_data in ipairs(belt_lines) do
                        if line_data.items then
                            for _, item in ipairs(line_data.items) do
                                local key = Util.make_quality_key(item.name, item.quality or Util.QUALITY_NORMAL)
                                total_item_counts[key] = (total_item_counts[key] or 0) + item.count
                                -- Belts are considered "storage" - items should be preserved
                                storage_item_counts[key] = (storage_item_counts[key] or 0) + item.count
                            end
                        end
                    end
                end)
            end

            -- Count inserter held items
            if entity_type == "inserter" then
                Util.pcall_warn("[TransferValidation] Inserter scan on " .. entity_name, function()
                    local held = InventoryScanner.extract_inserter_held_item(entity)
                    if held then
                        local key = Util.make_quality_key(held.name, held.quality or Util.QUALITY_NORMAL)
                        total_item_counts[key] = (total_item_counts[key] or 0) + held.count
                        -- Inserters are "in transit" - use storage validation
                        storage_item_counts[key] = (storage_item_counts[key] or 0) + held.count
                    end
                end)
            end
        end
    end
    
    -- Count ground items
    local ground_items = surface.find_entities_filtered({type = "item-entity"})
    for _, item_entity in ipairs(ground_items) do
        if item_entity.valid and item_entity.stack and item_entity.stack.valid_for_read then
            local stack = item_entity.stack
            local key = Util.make_quality_key(stack.name, (stack.quality and stack.quality.name) or Util.QUALITY_NORMAL)
            total_item_counts[key] = (total_item_counts[key] or 0) + stack.count
            storage_item_counts[key] = (storage_item_counts[key] or 0) + stack.count
        end
    end
    
    -- Count fluids
    local actual_fluid_counts = SurfaceCounter.count_fluids(surface, options.segment_temps)

    -- VALIDATION LOGIC:
    -- For total items: actual should be <= expected (we can lose items to machine limits, but not gain)
    -- For storage items: should match closely (these are passive containers)
    -- For consumer items: very lenient (machines may have consumed items or have inventory limits)
    
    local item_mismatches = {}
    local item_match = true
    
    -- strict=true (transfers): LAB-A measured zero source-export residual for both items and fluids.
    -- The complete frozen world is therefore exact: any per-key item gain/loss fails. The loose path
    -- predates the destructive transfer gate and remains for non-transfer callers only.
    local strict = options.strict == true
    local STORAGE_TOLERANCE = 5          -- loose: gain headroom
    local TOTAL_LOSS_TOLERANCE = 0.95    -- loose: up to 95% loss
    local MIN_ABSOLUTE_LOSS = 100        -- loose: and >100 absolute

    for item_name, expected_count in pairs(expected_verification.item_counts or {}) do
        local actual_count = total_item_counts[item_name] or 0
        local diff = expected_count - actual_count  -- Positive = items lost

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
            -- Check if we gained items (should never happen)
            if actual_count > expected_count + STORAGE_TOLERANCE then
                item_match = false
                table.insert(item_mismatches, string.format(
                    "%s: GAINED items - expected %d, got %d",
                    item_name, expected_count, actual_count
                ))
            -- Check if we lost more than tolerance allows
            elseif diff > expected_count * TOTAL_LOSS_TOLERANCE and diff > MIN_ABSOLUTE_LOSS then
                -- Only flag if we lost more than 95% AND more than 100 absolute items
                item_match = false
                table.insert(item_mismatches, string.format(
                    "%s: excessive loss - expected %d, got %d (lost %d, %.0f%%)",
                    item_name, expected_count, actual_count, diff, (diff/expected_count)*100
                ))
            end
        end
    end

    -- Check for unexpected items (items that shouldn't exist at all)
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

    -- Build mismatch details
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

    -- Compute summary totals for detailed stats
    local total_expected_items = Util.sum_items(expected_verification.item_counts or {})
    local total_actual_items = Util.sum_items(total_item_counts)
    local total_expected_fluids = Util.sum_fluids(expected_verification.fluid_counts or {})
    local total_actual_fluids = Util.sum_fluids(actual_fluid_counts)

    -- Per-item loss breakdown (instrumentation): exactly which items fall short. Under the strict
    -- transfer gate this is verdict input; loose non-transfer callers retain their legacy policy.
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
        -- Detailed counts for transaction log
        expectedItemCounts = expected_verification.item_counts or {},
        actualItemCounts = total_item_counts,
        expectedFluidCounts = expected_verification.fluid_counts or {},
        actualFluidCounts = actual_fluid_counts,
        entityTypeBreakdown = entity_type_counts,
        -- Summary totals
        itemTypesExpected = table_size(expected_verification.item_counts or {}),
        itemTypesActual = table_size(total_item_counts),
        fluidTypesExpected = table_size(expected_verification.fluid_counts or {}),
        fluidTypesActual = table_size(actual_fluid_counts),
        totalExpectedItems = total_expected_items,
        totalActualItems = total_actual_items,
        totalExpectedFluids = total_expected_fluids,
        totalActualFluids = total_actual_fluids,
        -- Per-item loss instrumentation (non-gating)
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

--- Store validation result for a transfer/job id (debug remote only; production uses import-complete payload).
--- @param result_id string: Canonical transfer id or job id
--- @param validation_result table: Validation result data
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

--- Clear a validation result by transfer/job id.
--- @param result_id string
function TransferValidation.clear_validation_result(result_id)
    if storage.validation_results and type(result_id) == "string" then
        storage.validation_results[result_id] = nil
    end
end

--- Get validation result by transfer/job id.
--- @param result_id string: Canonical transfer id or job id
--- @return table|nil: Validation result or nil if not found
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

--- Clean up old validation results
--- @param max_age_ticks number: Maximum age in ticks before cleanup
function TransferValidation.cleanup_old_results(max_age_ticks)
    if not storage.validation_results then
        return
    end

    max_age_ticks = max_age_ticks or 36000  -- Default: 10 minutes at 60 UPS

    for result_id, stored in pairs(storage.validation_results) do
        local age = game.tick - stored.timestamp
        if age > max_age_ticks then
            storage.validation_results[result_id] = nil
        end
    end
end

return TransferValidation
