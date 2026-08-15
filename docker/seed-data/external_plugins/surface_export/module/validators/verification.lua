local Util = require("modules/surface_export/utils/util")

local Verification = {}

function Verification.count_all_items(entities)
  local item_totals = {}

  for _, entity_data in ipairs(entities) do
    if entity_data.specific_data and entity_data.specific_data.inventories then
      for _, inventory in ipairs(entity_data.specific_data.inventories) do
        if inventory.items then
          for _, item in ipairs(inventory.items) do
            local key = Util.make_quality_key(item.name, item.quality or Util.QUALITY_NORMAL)
            item_totals[key] = (item_totals[key] or 0) + item.count
          end
        end
      end
    end

    if entity_data.specific_data and entity_data.specific_data.items then
      for _, line_data in ipairs(entity_data.specific_data.items) do
        if line_data.items then
          for _, item in ipairs(line_data.items) do
            local key = Util.make_quality_key(item.name, item.quality or Util.QUALITY_NORMAL)
            item_totals[key] = (item_totals[key] or 0) + item.count
          end
        end
      end
    end

    if entity_data.specific_data and entity_data.specific_data.held_item then
      local held = entity_data.specific_data.held_item
      local key = Util.make_quality_key(held.name, held.quality or Util.QUALITY_NORMAL)
      item_totals[key] = (item_totals[key] or 0) + held.count
    end

    if entity_data.type == "item-on-ground" then
      local key = Util.make_quality_key(entity_data.name, entity_data.quality or Util.QUALITY_NORMAL)
      item_totals[key] = (item_totals[key] or 0) + entity_data.count
    end
  end

  return item_totals
end

function Verification.count_fluid_segments(fluid_segments)
  local fluid_totals = {}
  for _, seg in ipairs(fluid_segments or {}) do
    if seg.fluid and (seg.total or 0) > 0 then
      local key = Util.make_fluid_temp_key(seg.fluid, seg.temperature or 15)
      fluid_totals[key] = (fluid_totals[key] or 0) + seg.total
    end
  end
  return fluid_totals
end

function Verification.verify_export(export_data)
  if not export_data then
    return false, "Export data is nil"
  end

  if not export_data.schema_version then
    return false, "Missing schema version"
  end

  if not export_data.entities or #export_data.entities == 0 then
    if export_data.verification and next(export_data.verification.item_counts) then
      return false, "Empty platform but non-empty item counts"
    end
    return true
  end

  if not export_data.metadata then
    return false, "Missing metadata"
  end

  if not export_data.verification then
    return false, "Missing verification section"
  end

  local calculated_items = Verification.count_all_items(export_data.entities)
  local stored_items = export_data.verification.item_counts

  for item_key, calc_count in pairs(calculated_items) do
    local stored_count = stored_items[item_key] or 0
    if calc_count ~= stored_count then
      return false, string.format(
        "Item count mismatch for '%s': calculated %d, stored %d",
        item_key, calc_count, stored_count
      )
    end
  end

  for item_key, stored_count in pairs(stored_items) do
    local calc_count = calculated_items[item_key] or 0
    if stored_count ~= calc_count then
      return false, string.format(
        "Item count mismatch for '%s': stored %d, calculated %d",
        item_key, stored_count, calc_count
      )
    end
  end

  local calculated_fluids = Verification.count_fluid_segments(export_data.fluid_segments)
  local stored_fluids = export_data.verification.fluid_counts

  for fluid_key, calc_amount in pairs(calculated_fluids) do
    local stored_amount = stored_fluids[fluid_key] or 0
    if math.abs(calc_amount - stored_amount) > 0.1 then
      return false, string.format(
        "Fluid amount mismatch for '%s': calculated %.2f, stored %.2f",
        fluid_key, calc_amount, stored_amount
      )
    end
  end

  return true
end


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
