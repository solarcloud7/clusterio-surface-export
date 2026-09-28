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

return Verification
