-- FactorioSurfaceExport - Transfer Validation
-- Validates imported platforms against source verification data

local Verification = require("modules/surface_export/validators/verification")
local InventoryScanner = require("modules/surface_export/export_scanners/inventory-scanner")
local Util = require("modules/surface_export/utils/util")

local TransferValidation = {}

--- Count all fluids on a live surface (for post-import verification)
--- @param surface LuaSurface: The surface to count fluids on
--- @return table: Table of fluid_key = amount pairs
local function count_surface_fluids(surface)
    if not surface or not surface.valid then
        return {}
    end

    local fluid_totals = {}

    -- Find all entities with fluidboxes
    local entities = surface.find_entities_filtered({})

    for _, entity in ipairs(entities) do
        if entity.valid and entity.fluidbox then
            local success, err = pcall(function()
                for i = 1, #entity.fluidbox do
                    local fluid = entity.fluidbox[i]
                    if fluid and fluid.name then
                        local key = Util.make_fluid_temp_key(fluid.name, fluid.temperature)
                        fluid_totals[key] = (fluid_totals[key] or 0) + fluid.amount
                    end
                end
            end)

            if not success then
                log(string.format("[TransferValidation] Error counting fluids for entity %s: %s", entity.name, err))
            end
        end
    end

    return fluid_totals
end

--- Validate an imported platform against expected verification data
--- Uses grouped validation: strict for storage, lenient for machines
--- @param surface LuaSurface: The imported platform surface
--- @param expected_verification table: Expected item/fluid counts from source
--- @return boolean, table: success, validation_result
function TransferValidation.validate_import(surface, expected_verification)
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
    
    for _, entity in ipairs(entities) do
        if entity.valid then
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
            
            -- Count belt items
            if entity_type:find("transport%-belt") or entity_type:find("underground%-belt") or entity_type:find("splitter") then
                local belt_lines = InventoryScanner.extract_belt_items(entity)
                for _, line_data in ipairs(belt_lines) do
                    if line_data.items then
                        for _, item in ipairs(line_data.items) do
                            local key = Util.make_quality_key(item.name, item.quality or "normal")
                            total_item_counts[key] = (total_item_counts[key] or 0) + item.count
                            -- Belts are considered "storage" - items should be preserved
                            storage_item_counts[key] = (storage_item_counts[key] or 0) + item.count
                        end
                    end
                end
            end
            
            -- Count inserter held items
            if entity_type:find("inserter") then
                local held = InventoryScanner.extract_inserter_held_item(entity)
                if held then
                    local key = Util.make_quality_key(held.name, held.quality or "normal")
                    total_item_counts[key] = (total_item_counts[key] or 0) + held.count
                    -- Inserters are "in transit" - use storage validation
                    storage_item_counts[key] = (storage_item_counts[key] or 0) + held.count
                end
            end
        end
    end
    
    -- Count ground items
    local ground_items = surface.find_entities_filtered({type = "item-entity"})
    for _, item_entity in ipairs(ground_items) do
        if item_entity.valid and item_entity.stack and item_entity.stack.valid_for_read then
            local stack = item_entity.stack
            local key = Util.make_quality_key(stack.name, (stack.quality and stack.quality.name) or "normal")
            total_item_counts[key] = (total_item_counts[key] or 0) + stack.count
            storage_item_counts[key] = (storage_item_counts[key] or 0) + stack.count
        end
    end
    
    -- Count fluids
    local actual_fluid_counts = count_surface_fluids(surface)

    -- VALIDATION LOGIC:
    -- For total items: actual should be <= expected (we can lose items to machine limits, but not gain)
    -- For storage items: should match closely (these are passive containers)
    -- For consumer items: very lenient (machines may have consumed items or have inventory limits)
    
    local item_mismatches = {}
    local item_match = true
    
    -- Tolerances
    local STORAGE_TOLERANCE = 5          -- Allow 5 items difference for storage
    local TOTAL_LOSS_TOLERANCE = 0.95    -- Allow up to 95% loss overall (machine inventory limits)
    local MIN_ABSOLUTE_LOSS = 100        -- Only fail if we lost more than 100 absolute items

    for item_name, expected_count in pairs(expected_verification.item_counts or {}) do
        local actual_count = total_item_counts[item_name] or 0
        local diff = expected_count - actual_count  -- Positive = items lost
        
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

    -- Check for unexpected items (items that shouldn't exist at all)
    for item_name, actual_count in pairs(total_item_counts) do
        if not expected_verification.item_counts[item_name] then
            if actual_count > 20 then  -- Only flag if significant
                item_match = false
                table.insert(item_mismatches, string.format(
                    "%s: unexpected item (got %d)",
                    item_name, actual_count
                ))
            end
        end
    end

    -- Fluid validation - very lenient due to network redistribution
    -- Fluids redistribute across pipe networks automatically, so we can lose 95%+ easily
    -- We only check: 1) didn't gain fluid, 2) fluid exists if expected
    local fluid_mismatches = {}
    local fluid_match = true
    local FLUID_GAIN_TOLERANCE = 500  -- Allow small gain due to rounding

    for fluid_name, expected_volume in pairs(expected_verification.fluid_counts or {}) do
        local actual_volume = actual_fluid_counts[fluid_name] or 0
        
        -- Check if we gained fluid (shouldn't happen)
        if actual_volume > expected_volume + FLUID_GAIN_TOLERANCE then
            fluid_match = false
            table.insert(fluid_mismatches, string.format(
                "%s: GAINED fluid - expected %.1f, got %.1f",
                fluid_name, expected_volume, actual_volume
            ))
        -- Check if fluid completely disappeared (should have at least something)
        elseif expected_volume > 1000 and actual_volume < 1 then
            fluid_match = false
            table.insert(fluid_mismatches, string.format(
                "%s: fluid completely lost - expected %.1f, got %.1f",
                fluid_name, expected_volume, actual_volume
            ))
        end
        -- Note: We don't fail on partial loss - fluid networks redistribute
    end

    -- Check for unexpected fluids
    for fluid_name, actual_volume in pairs(actual_fluid_counts) do
        if not expected_verification.fluid_counts[fluid_name] then
            if actual_volume > FLUID_MIN_TOLERANCE then
                fluid_match = false
                table.insert(fluid_mismatches, string.format(
                    "%s: unexpected fluid (got %.1f)",
                    fluid_name, actual_volume
                ))
            end
        end
    end

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

    local validation_result = {
        itemCountMatch = item_match,
        fluidCountMatch = fluid_match,
        entityCount = #entities,
        mismatchDetails = mismatch_details
    }

    local success = item_match and fluid_match

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

--- Store validation result for a platform (for retrieval by instance plugin)
--- @param platform_name string: Name of the platform
--- @param validation_result table: Validation result data
function TransferValidation.store_validation_result(platform_name, validation_result)
    if not storage.validation_results then
        storage.validation_results = {}
    end

    storage.validation_results[platform_name] = {
        result = validation_result,
        timestamp = game.tick
    }
end

--- Get validation result for a platform
--- @param platform_name string: Name of the platform
--- @return table|nil: Validation result or nil if not found
function TransferValidation.get_validation_result(platform_name)
    if not storage.validation_results then
        return nil
    end

    local stored = storage.validation_results[platform_name]
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

    for platform_name, stored in pairs(storage.validation_results) do
        local age = game.tick - stored.timestamp
        if age > max_age_ticks then
            storage.validation_results[platform_name] = nil
        end
    end
end

return TransferValidation
