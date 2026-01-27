-- FactorioSurfaceExport - Verification
-- CRITICAL: Ensures zero item loss and zero duplication through verification

local Util = require("modules/surface_export/utils/util")
local InventoryScanner = require("modules/surface_export/export_scanners/inventory-scanner")

local Verification = {}

--- Count all items in serialized entity data
--- CRITICAL: This is used to verify item counts match expected values
--- @param entity_data table: Array of serialized entities
--- @return table: Table of item_key = total_count pairs
function Verification.count_all_items(entity_data)
  local item_totals = {}

  for _, entity in ipairs(entity_data) do
    -- Count items in inventories
    if entity.specific_data and entity.specific_data.inventories then
      for _, inventory in ipairs(entity.specific_data.inventories) do
        if inventory.items then
          for _, item in ipairs(inventory.items) do
            -- Use quality-aware key
            local key = Util.make_quality_key(item.name, item.quality or "normal")
            item_totals[key] = (item_totals[key] or 0) + item.count
          end
        end
      end
    end

    -- Count items on belts (structured as lines with items array)
    if entity.specific_data and entity.specific_data.items then
      for _, line_data in ipairs(entity.specific_data.items) do
        if line_data.items then
          for _, item in ipairs(line_data.items) do
            local key = Util.make_quality_key(item.name, item.quality or "normal")
            item_totals[key] = (item_totals[key] or 0) + item.count
          end
        end
      end
    end

    -- Count held items (inserters)
    if entity.specific_data and entity.specific_data.held_item then
      local held = entity.specific_data.held_item
      local key = Util.make_quality_key(held.name, held.quality or "normal")
      item_totals[key] = (item_totals[key] or 0) + held.count
    end

    -- Count items on ground
    if entity.type == "item-on-ground" then
      local key = Util.make_quality_key(entity.name, entity.quality or "normal")
      item_totals[key] = (item_totals[key] or 0) + entity.count
    end
  end

  return item_totals
end

--- Count all fluids in serialized entity data
--- @param entity_data table: Array of serialized entities
--- @return table: Table of fluid_key = total_amount pairs
function Verification.count_all_fluids(entity_data)
  local fluid_totals = {}

  for _, entity in ipairs(entity_data) do
    -- Count fluids in fluidboxes
    if entity.specific_data and entity.specific_data.fluids then
      for _, fluid in ipairs(entity.specific_data.fluids) do
        -- Use temperature-aware key
        local key = Util.make_fluid_temp_key(fluid.name, fluid.temperature)
        fluid_totals[key] = (fluid_totals[key] or 0) + fluid.amount
      end
    end
  end

  return fluid_totals
end

--- Verify export data integrity
--- CRITICAL: This ensures item counts are consistent
--- @param export_data table: Complete export data structure
--- @return boolean, string|nil: true if valid, false and error message if invalid
function Verification.verify_export(export_data)
  if not export_data then
    return false, "Export data is nil"
  end

  -- Verify schema version
  if not export_data.schema_version then
    return false, "Missing schema version"
  end

  -- Verify entities exist
  if not export_data.entities or #export_data.entities == 0 then
    -- Empty platform is valid, but should have empty verification
    if export_data.verification and next(export_data.verification.item_counts) then
      return false, "Empty platform but non-empty item counts"
    end
    return true  -- Empty platform is valid
  end

  -- Verify metadata
  if not export_data.metadata then
    return false, "Missing metadata"
  end

  -- Verify verification section
  if not export_data.verification then
    return false, "Missing verification section"
  end

  -- CRITICAL: Recalculate item counts and compare
  local calculated_items = Verification.count_all_items(export_data.entities)
  local stored_items = export_data.verification.item_counts

  -- Check every calculated item
  for item_key, calc_count in pairs(calculated_items) do
    local stored_count = stored_items[item_key] or 0
    if calc_count ~= stored_count then
      return false, string.format(
        "Item count mismatch for '%s': calculated %d, stored %d",
        item_key, calc_count, stored_count
      )
    end
  end

  -- Check every stored item (ensure nothing extra in stored)
  for item_key, stored_count in pairs(stored_items) do
    local calc_count = calculated_items[item_key] or 0
    if stored_count ~= calc_count then
      return false, string.format(
        "Item count mismatch for '%s': stored %d, calculated %d",
        item_key, stored_count, calc_count
      )
    end
  end

  -- Verify fluid counts
  local calculated_fluids = Verification.count_all_fluids(export_data.entities)
  local stored_fluids = export_data.verification.fluid_counts

  for fluid_key, calc_amount in pairs(calculated_fluids) do
    local stored_amount = stored_fluids[fluid_key] or 0
    -- Allow small floating point differences
    if math.abs(calc_amount - stored_amount) > 0.1 then
      return false, string.format(
        "Fluid amount mismatch for '%s': calculated %.2f, stored %.2f",
        fluid_key, calc_amount, stored_amount
      )
    end
  end

  return true
end

--- Count all items on a live surface (for post-import verification)
--- @param surface LuaSurface: The surface to count items on
--- @return table: Table of item_key = count pairs
function Verification.count_surface_items(surface)
  if not surface or not surface.valid then
    return {}
  end

  local item_totals = {}

  -- Find all entities
  local entities = surface.find_entities_filtered({})

  for _, entity in ipairs(entities) do
    if entity.valid then
      local success, err = pcall(function()
        local inventories = InventoryScanner.extract_all_inventories(entity)
        local inventory_totals = InventoryScanner.count_all_items(inventories)
        for key, count in pairs(inventory_totals) do
          item_totals[key] = (item_totals[key] or 0) + count
        end

        -- Belt items are returned as array of {line=N, items={...}}
        if entity.type:find("transport%-belt") or entity.type:find("underground%-belt") or entity.type:find("splitter") then
          local belt_lines = InventoryScanner.extract_belt_items(entity)
          for _, line_data in ipairs(belt_lines) do
            if line_data.items then
              for _, item in ipairs(line_data.items) do
                local key = Util.make_quality_key(item.name, item.quality or "normal")
                item_totals[key] = (item_totals[key] or 0) + item.count
              end
            end
          end
        end

        if entity.type:find("inserter") then
          local held = InventoryScanner.extract_inserter_held_item(entity)
          if held then
            local key = Util.make_quality_key(held.name, held.quality or "normal")
            item_totals[key] = (item_totals[key] or 0) + held.count
          end
        end
      end)

      if not success then
        log(string.format("[FactorioSurfaceExport] Error counting items for entity %s: %s", entity.name, err))
      end
    end
  end

  -- Count items on ground
  local ground_items = surface.find_entities_filtered({type = "item-entity"})
  for _, item_entity in ipairs(ground_items) do
    if item_entity.valid and item_entity.stack and item_entity.stack.valid_for_read then
      local stack = item_entity.stack
      local key = Util.make_quality_key(stack.name, (stack.quality and stack.quality.name) or "normal")
      item_totals[key] = (item_totals[key] or 0) + stack.count
    end
  end

  return item_totals
end

--- Count all fluids on a live surface (for post-export/import verification)
--- @param surface LuaSurface: The surface to count fluids on
--- @return table: Table of fluid_key = amount pairs
function Verification.count_surface_fluids(surface)
  if not surface or not surface.valid then
    return {}
  end

  local fluid_totals = {}

  -- Find all entities with fluidboxes
  local entities = surface.find_entities_filtered({})

  for _, entity in ipairs(entities) do
    if entity.valid and entity.fluidbox then
      for i = 1, #entity.fluidbox do
        local fluid = entity.fluidbox[i]
        if fluid and fluid.name then
          local key = Util.make_fluid_temp_key(fluid.name, fluid.temperature)
          fluid_totals[key] = (fluid_totals[key] or 0) + fluid.amount
        end
      end
    end
  end

  return fluid_totals
end

--- Generate a verification report comparing expected vs actual counts
--- @param expected table: Expected item counts
--- @param actual table: Actual item counts
--- @return boolean, table: success flag and report details
function Verification.generate_report(expected, actual)
  local report = {
    matches = {},
    mismatches = {},
    missing = {},
    extra = {}
  }

  local all_items = {}
  for item, _ in pairs(expected) do all_items[item] = true end
  for item, _ in pairs(actual) do all_items[item] = true end

  for item, _ in pairs(all_items) do
    local exp = expected[item] or 0
    local act = actual[item] or 0

    if exp == act then
      table.insert(report.matches, {item = item, count = exp})
    elseif exp > act then
      table.insert(report.missing, {item = item, expected = exp, actual = act, difference = exp - act})
    elseif act > exp then
      table.insert(report.extra, {item = item, expected = exp, actual = act, difference = act - exp})
    else
      table.insert(report.mismatches, {item = item, expected = exp, actual = act})
    end
  end

  local success = #report.mismatches == 0 and #report.missing == 0 and #report.extra == 0

  return success, report
end

--- Print verification report to game console
--- @param report table: Report from generate_report
function Verification.print_report(report)
  game.print("=== Verification Report ===")

  if #report.matches > 0 then
    game.print(string.format("Matches: %d items verified", #report.matches))
  end

  if #report.mismatches > 0 then
    game.print("MISMATCHES:")
    for _, mismatch in ipairs(report.mismatches) do
      game.print(string.format("  %s: expected %d, got %d",
        mismatch.item, mismatch.expected, mismatch.actual))
    end
  end

  if #report.missing > 0 then
    game.print("MISSING ITEMS:")
    for _, missing in ipairs(report.missing) do
      game.print(string.format("  %s: missing %d (expected %d, got %d)",
        missing.item, missing.difference, missing.expected, missing.actual))
    end
  end

  if #report.extra > 0 then
    game.print("EXTRA ITEMS:")
    for _, extra in ipairs(report.extra) do
      game.print(string.format("  %s: extra %d (expected %d, got %d)",
        extra.item, extra.difference, extra.expected, extra.actual))
    end
  end
end

return Verification
