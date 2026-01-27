-- FactorioSurfaceExport - Inventory Scanner
-- Uses dynamic inventory discovery via get_max_inventory_index()

local Util = require("modules/surface_export/utils/util")

local InventoryScanner = {}

--- Helper to safely extract item properties using pcall
--- @param stack LuaItemStack: The item stack
--- @return table: Item entry with all properties
local function extract_item_properties(stack)
  local item_entry = {
    name = stack.name,
    count = stack.count,
    quality = (stack.quality and stack.quality.name) or "normal"
  }

  -- Blueprint/book export strings
  if stack.is_blueprint or stack.is_blueprint_book or 
     stack.is_upgrade_item or stack.is_deconstruction_item or 
     stack.is_item_with_tags then
    local call_success, call_return = pcall(function() return stack.export_stack() end)
    if call_success and call_return then
      item_entry.export_string = call_return
    end
  end

  -- Health (damaged items: armor, vehicles, etc.)
  local health_success, health = pcall(function() return stack.health end)
  if health_success and health then
    item_entry.health = health
  end

  -- Durability (for tools, armor)
  local durability_success, durability = pcall(function() return stack.durability end)
  if durability_success and durability then
    item_entry.durability = durability
  end

  -- Ammo count (partial magazines)
  local ammo_success, ammo = pcall(function() return stack.ammo end)
  if ammo_success and ammo then
    item_entry.ammo = ammo
  end

  -- Spoilage (Space Age - items that decay over time)
  local spoil_success, spoil_percent = pcall(function() return stack.spoil_percent end)
  if spoil_success and spoil_percent then
    item_entry.spoil_percent = spoil_percent
  end

  -- Spoil result (what it turns into when spoiled)
  local result_success, spoil_result = pcall(function() return stack.spoil_result end)
  if result_success and spoil_result and spoil_result.name then
    item_entry.spoil_result = spoil_result.name
  end

  -- Item labels and colors (custom-labeled items)
  if stack.is_item_with_label then
    local label_success, label_data = pcall(function()
      return {
        text = stack.label,
        color = stack.label_color,
        allow_manual_change = stack.allow_manual_label_change
      }
    end)
    if label_success and label_data then
      item_entry.label = label_data
    end
  end

  -- Custom description (for tagged items)
  local desc_success, custom_desc = pcall(function() return stack.custom_description end)
  if desc_success and custom_desc then
    item_entry.custom_description = custom_desc
  end

  -- Grid equipment (for power armor)
  local grid_success, grid = pcall(function() return stack.grid end)
  if grid_success and grid and grid.equipment then
    item_entry.grid = InventoryScanner.extract_equipment_grid(grid)
  end

  -- Nested inventory (spidertron remote, etc.)
  if stack.is_item_with_inventory then
    local sub_inventory = stack.get_inventory(defines.inventory.item_main)
    if sub_inventory and sub_inventory.valid then
      item_entry.nested_inventory = InventoryScanner.extract_nested_inventory(sub_inventory)
    end
  end

  return item_entry
end

--- Extract all inventories from an entity using dynamic discovery
--- Uses get_max_inventory_index() to find all inventories an entity supports
--- @param entity LuaEntity: The entity to extract from
--- @return table: Array of inventory data
function InventoryScanner.extract_all_inventories(entity)
  if not entity or not entity.valid then
    return {}
  end

  local inventories = {}
  local visited_inventories = {} -- Track visited inventory objects to handle aliased defines

  -- Dynamically discover the maximum inventory index for this entity
  local max_inv_index = entity.get_max_inventory_index()
  
  for inv_index = 1, max_inv_index do
    local inventory = entity.get_inventory(inv_index)

    if inventory and inventory.valid and not inventory.is_empty() then
      -- Deduplicate inventories (some defines map to the same inventory, e.g. deprecated ones)
      if not visited_inventories[inventory] then
        visited_inventories[inventory] = true

        -- Get the inventory type name dynamically
        local inv_type_name = entity.get_inventory_name(inv_index)

        -- Iterate slots directly for 2.0 compatibility and performance
        local inv_data = {
          type = inv_type_name,
          items = {}
        }

        for i = 1, #inventory do
          local stack = inventory[i]
          if stack and stack.valid_for_read then
              -- Use shared helper for all item property extraction
              local item_entry = extract_item_properties(stack)
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

--- Extract equipment grid from power armor or vehicles
--- @param grid LuaEquipmentGrid: The equipment grid
--- @return table: Equipment grid data with dimensions and equipment
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
      shield = equip.shield,
      quality = equip.quality and equip.quality.name or "normal"
    }
    
    -- Burner equipment (fuel items)
    if equip.burner then
      local burner = equip.burner
      equip_data.burner = {
        currently_burning = burner.currently_burning and burner.currently_burning.name or nil,
        remaining_burning_fuel = burner.remaining_burning_fuel
      }
      
      -- Burner fuel inventory
      if burner.inventory and burner.inventory.valid then
        equip_data.burner.inventory = InventoryScanner.extract_nested_inventory(burner.inventory)
      end
      
      -- Burner result inventory
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

--- Extract nested inventory (recursive for items-with-inventory)
--- Used for spidertron remotes, blueprint books, etc.
--- @param inventory LuaInventory: The nested inventory
--- @return table: Array of item data
function InventoryScanner.extract_nested_inventory(inventory)
  if not inventory or not inventory.valid then
    return {}
  end

  local items = {}

  for i = 1, #inventory do
    local stack = inventory[i]
    if stack and stack.valid_for_read then
      -- Use shared helper for all item property extraction (includes pcall protection)
      local item_entry = extract_item_properties(stack)
      table.insert(items, item_entry)
    end
  end

  return items
end

--- Extract items from transport belt lines with exact positions
--- Factorio 2.0: Uses get_detailed_contents() to capture exact item positions (0.0-1.0)
--- This allows restoration with insert_at() instead of insert_at_back() to avoid "belt full" errors
--- @param entity LuaEntity: The belt entity
--- @return table: Array of line data with positioned items
function InventoryScanner.extract_belt_items(entity)
  if not entity or not entity.valid then
    return {}
  end

  local lines = {}

  -- Transport belts have 2 transport lines (left and right lanes)
  for line_index = 1, 2 do
    local line = entity.get_transport_line(line_index)
    if line and line.valid then
      -- Use get_detailed_contents() to get exact positions (Factorio 2.0)
      -- Returns array of {stack: LuaItemStack, position: float, unique_id: uint32}
      local detailed = line.get_detailed_contents()
      
      local items = {}
      for _, item_data in ipairs(detailed) do
        -- item_data.stack is a LuaItemStack, access its properties
        local stack = item_data.stack
        if stack and stack.valid_for_read then
          table.insert(items, {
            name = stack.name,
            position = item_data.position,  -- CRITICAL: float 0.0-1.0 along belt
            count = stack.count,            -- Stack size (1-4 in 2.0)
            quality = stack.quality and stack.quality.name or "normal"
          })
        end
      end
      
      if #items > 0 then
        table.insert(lines, {
          line = line_index,
          items = items
        })
      end
    end
  end

  return lines
end

--- Extract item held by an inserter
--- @param entity LuaEntity: The inserter entity
--- @return table|nil: Item data, or nil if no item held
function InventoryScanner.extract_inserter_held_item(entity)
  if not entity or not entity.valid then
    return nil
  end

  local held_stack = entity.held_stack
  if held_stack and held_stack.valid_for_read then
    return {
      name = held_stack.name,
      count = held_stack.count,
      quality = held_stack.quality and held_stack.quality.name or "normal"
    }
  end

  return nil
end

--- Extract fluids from an entity's fluidboxes
--- @param entity LuaEntity: The entity with fluidboxes
--- @return table: Array of fluid data
function InventoryScanner.extract_fluids(entity)
  if not entity or not entity.valid then
    return {}
  end

  local fluidbox = entity.fluidbox
  if not fluidbox then
    return {}
  end

  local fluids = {}

  -- Iterate through all fluidbox slots
  for i = 1, #fluidbox do
    local fluid = fluidbox[i]
    if fluid then
      -- CRITICAL: Track temperature separately
      -- Different temperatures of the same fluid are different resources
      table.insert(fluids, {
        name = fluid.name,
        amount = fluid.amount,
        temperature = fluid.temperature
      })
    end
  end

  return fluids
end

--- Extract fluid from pipes
--- Pipes are a special case of fluidboxes
--- @param entity LuaEntity: The pipe entity
--- @return table: Fluid data
function InventoryScanner.extract_pipe_fluids(entity)
  -- Pipes use the same fluidbox system
  return InventoryScanner.extract_fluids(entity)
end

--- Count all items in inventories (for verification)
--- @param inventories table: Array of inventory data
--- @return table: Table of item_name = total_count pairs
function InventoryScanner.count_all_items(inventories)
  local totals = {}

  for _, inv in ipairs(inventories) do
    if inv.items then
      for _, item in ipairs(inv.items) do
        -- Create quality-aware key
        local key = Util.make_quality_key(item.name, item.quality)
        totals[key] = (totals[key] or 0) + item.count
      end
    end
  end

  return totals
end

--- Count all fluids in fluidboxes (for verification)
--- @param fluids table: Array of fluid data
--- @return table: Table of fluid_name@temp = total_amount pairs
function InventoryScanner.count_all_fluids(fluids)
  local totals = {}

  for _, fluid in ipairs(fluids) do
    -- Create temperature-aware key
    local key = Util.make_fluid_temp_key(fluid.name, fluid.temperature)
    totals[key] = (totals[key] or 0) + fluid.amount
  end

  return totals
end

return InventoryScanner
