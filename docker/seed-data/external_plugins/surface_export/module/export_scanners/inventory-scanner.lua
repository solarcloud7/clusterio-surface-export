local Util = require("modules/surface_export/utils/util")
local FluidRegistry = require("modules/surface_export/export_scanners/fluid-registry")

local InventoryScanner = {}

InventoryScanner.fluid_registry = nil

local function extract_item_properties(stack)
  local item_entry = {
    name = stack.name,
    count = stack.count,
    quality = (stack.quality and stack.quality.name) or Util.QUALITY_NORMAL
  }

  if stack.is_blueprint or stack.is_blueprint_book or 
     stack.is_upgrade_item or stack.is_deconstruction_item or 
     stack.is_item_with_tags then
    local call_success, call_return = pcall(function() return stack.export_stack() end)
    if not call_success then log(string.format("[inventory-scanner] export_stack failed on %s: %s", stack.name, tostring(call_return))) end
    if call_success and call_return then
      item_entry.export_string = call_return
    end
  end

  -- intentional probe; failure expected, no log
  local health_success, health = pcall(function() return stack.health end)
  if health_success and health then
    item_entry.health = health
  end

  -- intentional probe; failure expected, no log
  local durability_success, durability = pcall(function() return stack.durability end)
  if durability_success and durability then
    item_entry.durability = durability
  end

  -- intentional probe; failure expected, no log
  local ammo_success, ammo = pcall(function() return stack.ammo end)
  if ammo_success and ammo then
    item_entry.ammo = ammo
  end

  -- intentional probe; failure expected, no log
  local spoil_success, spoil_percent = pcall(function() return stack.spoil_percent end)
  if spoil_success and spoil_percent then
    item_entry.spoil_percent = spoil_percent
  end

  if stack.is_item_with_label then
    local label_success, label_data = pcall(function()
      return {
        text = stack.label,
        color = stack.label_color,
        allow_manual_change = stack.allow_manual_label_change
      }
    end)
    if not label_success then log(string.format("[inventory-scanner] read item label failed on %s: %s", stack.name, tostring(label_data))) end
    if label_success and label_data then
      item_entry.label = label_data
    end
  end

  -- intentional probe; failure expected, no log
  local desc_success, custom_desc = pcall(function() return stack.custom_description end)
  if desc_success and custom_desc then
    item_entry.custom_description = custom_desc
  end

  -- intentional probe; failure expected, no log
  local grid_success, grid = pcall(function() return stack.grid end)
  if grid_success and grid and grid.equipment then
    item_entry.grid = InventoryScanner.extract_equipment_grid(grid)
  end

  if stack.is_item_with_inventory then
    local sub_inventory = stack.get_inventory(defines.inventory.item_main)
    if sub_inventory and sub_inventory.valid then
      item_entry.nested_inventory = InventoryScanner.extract_nested_inventory(sub_inventory)
    end
  end

  if stack.prototype.type == "item-with-entity-data" then
    local entity_data_ok, entity_data_values = pcall(function()
      return {
        entity_color = stack.entity_color,
        entity_enable_logistics_while_moving = stack.entity_enable_logistics_while_moving,
        entity_logistic_sections = stack.entity_logistic_sections,
        entity_logistics_enabled = stack.entity_logistics_enabled,
        entity_request_from_buffers = stack.entity_request_from_buffers,
      }
    end)
    if entity_data_ok then
      item_entry.entity_data = entity_data_values
    else
      log(string.format("[inventory-scanner] item entity-data read failed on %s: %s",
        stack.name, tostring(entity_data_values)))
    end
  end

  return item_entry
end

function InventoryScanner.extract_all_inventories(entity)
  if not entity or not entity.valid then
    return {}
  end

  local inventories = {}
  local visited_inventories = {}

  local max_inv_index = entity.get_max_inventory_index()
  
  for inv_index = 1, max_inv_index do
    local inventory = entity.get_inventory(inv_index)

    if inventory and inventory.valid and not inventory.is_empty() then
      if not visited_inventories[inventory] then
        visited_inventories[inventory] = true

        local inv_type_name = entity.get_inventory_name(inv_index)

        local inv_data = {
          type = inv_type_name,
          items = {}
        }

        for i = 1, #inventory do
          local stack = inventory[i]
          if stack and stack.valid_for_read then
              local item_entry = extract_item_properties(stack)
              item_entry.slot = i
              table.insert(inv_data.items, item_entry)
          end
        end

        if #inv_data.items > 0 then
          table.insert(inventories, inv_data)
        end
      end
    end
  end

  return inventories
end

function InventoryScanner.extract_equipment_grid(grid)
  if not grid or not grid.valid then
    return {}
  end

  local equipment = {}

  for _, equip in ipairs(grid.equipment) do
    local equip_data = {
      name = equip.name,
      position = equip.position,
      energy = equip.energy,
      shield = (equip.max_shield and equip.max_shield > 0) and equip.shield or nil,
      quality = equip.quality and equip.quality.name or Util.QUALITY_NORMAL
    }
    
    if equip.burner then
      local burner = equip.burner
      local eq_burning = burner.currently_burning
      local eq_burning_name = eq_burning and eq_burning.name or nil
      if eq_burning_name ~= nil and type(eq_burning_name) ~= "string" then eq_burning_name = eq_burning_name.name end
      local eq_burning_quality = eq_burning and eq_burning.quality or nil
      if eq_burning_quality ~= nil and type(eq_burning_quality) ~= "string" then eq_burning_quality = eq_burning_quality.name end
      equip_data.burner = {
        currently_burning = eq_burning_name and {
          name = eq_burning_name,
          quality = eq_burning_quality or Util.QUALITY_NORMAL
        } or nil,
        remaining_burning_fuel = burner.remaining_burning_fuel
      }
      
      if burner.inventory and burner.inventory.valid then
        equip_data.burner.inventory = InventoryScanner.extract_nested_inventory(burner.inventory)
      end
      
      if burner.burnt_result_inventory and burner.burnt_result_inventory.valid then
        equip_data.burner.burnt_result_inventory = InventoryScanner.extract_nested_inventory(burner.burnt_result_inventory)
      end
    end
    
    table.insert(equipment, equip_data)
  end

  return {
    width = grid.width,
    height = grid.height,
    equipment = equipment
  }
end

function InventoryScanner.extract_nested_inventory(inventory)
  if not inventory or not inventory.valid then
    return {}
  end

  local items = {}

  for i = 1, #inventory do
    local stack = inventory[i]
    if stack and stack.valid_for_read then
      local item_entry = extract_item_properties(stack)
      table.insert(items, item_entry)
    end
  end

  return items
end

function InventoryScanner.extract_belt_items(entity)
  if not entity or not entity.valid then
    return {}
  end

  local lines = {}

  local max_lines = entity.get_max_transport_line_index()
  for line_index = 1, max_lines do
    local line = entity.get_transport_line(line_index)
    if line and line.valid then
      local detailed = line.get_detailed_contents()
      local items = {}
      for _, item_data in ipairs(detailed) do
        local stack = item_data.stack
        if stack and stack.valid_for_read then
          table.insert(items, {
            name = stack.name,
            position = item_data.position,
            count = stack.count,
            quality = stack.quality and stack.quality.name or Util.QUALITY_NORMAL
          })
        end
      end
      if #items > 0 then
        table.insert(lines, { line = line_index, items = items })
      end
    end
  end

  return lines
end

function InventoryScanner.extract_inserter_held_item(entity)
  if not entity or not entity.valid then
    return nil
  end

  local held_stack = entity.held_stack
  if held_stack and held_stack.valid_for_read then
    return {
      name = held_stack.name,
      count = held_stack.count,
      quality = held_stack.quality and held_stack.quality.name or Util.QUALITY_NORMAL
    }
  end

  return nil
end

function InventoryScanner.extract_fluidboxes(entity)
  if not entity or not entity.valid then
    return nil
  end
  local registry = InventoryScanner.fluid_registry
  if not registry then
    error("[InventoryScanner] fluid capture without an armed FluidRegistry (single-discipline violation)")
  end
  return FluidRegistry.capture_entity(registry, entity)
end


function InventoryScanner.count_all_items(inventories)
  local totals = {}

  for _, inv in ipairs(inventories) do
    if inv.items then
      for _, item in ipairs(inv.items) do
        local key = Util.make_quality_key(item.name, item.quality)
        totals[key] = (totals[key] or 0) + item.count
      end
    end
  end

  return totals
end

return InventoryScanner
