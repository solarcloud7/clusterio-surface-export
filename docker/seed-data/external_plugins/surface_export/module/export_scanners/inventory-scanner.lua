-- FactorioSurfaceExport - Inventory Scanner
-- Uses dynamic inventory discovery via get_max_inventory_index()

local Util = require("modules/surface_export/utils/util")
local FluidOwnership = require("modules/surface_export/utils/fluid-ownership")

local InventoryScanner = {}

-- When set to a table, extract_fluids uses segment-level deduplication:
-- seg_id → {fluid=name, amount=total, energy=total_temp_product}
-- This ensures export captures the same weighted-average temperature that
-- FluidRestoration.restore() will later write, preventing cosmetic mismatches.
-- Set by AsyncProcessor at export job start, cleared to nil at job completion.
InventoryScanner.fluid_segment_cache = nil
InventoryScanner.engine_owned_segments = nil

--- Helper to safely extract item properties using pcall
--- @param stack LuaItemStack: The item stack
--- @return table: Item entry with all properties
local function extract_item_properties(stack)
  local item_entry = {
    name = stack.name,
    count = stack.count,
    quality = (stack.quality and stack.quality.name) or Util.QUALITY_NORMAL
  }

  -- Blueprint/book export strings
  if stack.is_blueprint or stack.is_blueprint_book or 
     stack.is_upgrade_item or stack.is_deconstruction_item or 
     stack.is_item_with_tags then
    local call_success, call_return = pcall(function() return stack.export_stack() end)
    if not call_success then log(string.format("[inventory-scanner] export_stack failed on %s: %s", stack.name, tostring(call_return))) end
    if call_success and call_return then
      item_entry.export_string = call_return
    end
  end

  -- Health (damaged items: armor, vehicles, etc.)
  -- intentional probe; failure expected, no log
  local health_success, health = pcall(function() return stack.health end)
  if health_success and health then
    item_entry.health = health
  end

  -- Durability (for tools, armor)
  -- intentional probe; failure expected, no log
  local durability_success, durability = pcall(function() return stack.durability end)
  if durability_success and durability then
    item_entry.durability = durability
  end

  -- Ammo count (partial magazines)
  -- intentional probe; failure expected, no log
  local ammo_success, ammo = pcall(function() return stack.ammo end)
  if ammo_success and ammo then
    item_entry.ammo = ammo
  end

  -- Spoilage (Space Age - items that decay over time)
  -- intentional probe; failure expected, no log
  local spoil_success, spoil_percent = pcall(function() return stack.spoil_percent end)
  if spoil_success and spoil_percent then
    item_entry.spoil_percent = spoil_percent
  end

  -- Spoil result (what it turns into when spoiled)
  -- intentional probe; failure expected, no log
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
    if not label_success then log(string.format("[inventory-scanner] read item label failed on %s: %s", stack.name, tostring(label_data))) end
    if label_success and label_data then
      item_entry.label = label_data
    end
  end

  -- Custom description (for tagged items)
  -- intentional probe; failure expected, no log
  local desc_success, custom_desc = pcall(function() return stack.custom_description end)
  if desc_success and custom_desc then
    item_entry.custom_description = custom_desc
  end

  -- Grid equipment (for power armor)
  -- intentional probe; failure expected, no log
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
              item_entry.slot = i  -- Preserve slot index for per-slot restoration (overloaded stacks)
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
      quality = equip.quality and equip.quality.name or Util.QUALITY_NORMAL
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

  -- Transport lines vary by belt type — iterate EXACTLY the belt's real line count via
  -- get_max_transport_line_index() (verified on 2.0.77: transport-belt=2, underground-belt=4, splitter=8),
  -- so get_transport_line() is never called out of range. The old `max_lines=8` pcall-until-throw
  -- over-iterated and THREW on the surplus indices, dumping ~500-600 synchronous log() writes + ~2000
  -- pcall/closure allocations into the export-completion tick — a #86 heartbeat-stall contributor. The
  -- import side already avoids blind iteration via the captured line_data.line (belt_restoration.lua).
  local max_lines = entity.get_max_transport_line_index()
  for line_index = 1, max_lines do
    local line = entity.get_transport_line(line_index)
    if line and line.valid then
      -- get_detailed_contents(): array of {stack: LuaItemStack, position: float 0.0-1.0, unique_id}
      local detailed = line.get_detailed_contents()
      local items = {}
      for _, item_data in ipairs(detailed) do
        local stack = item_data.stack
        if stack and stack.valid_for_read then
          table.insert(items, {
            name = stack.name,
            position = item_data.position,  -- CRITICAL: float 0.0-1.0 along belt
            count = stack.count,            -- Stack size (1-4 in 2.0)
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
      quality = held_stack.quality and held_stack.quality.name or Util.QUALITY_NORMAL
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
  local cache = InventoryScanner.fluid_segment_cache
  local engine_owned_segments = InventoryScanner.engine_owned_segments or {}

  if cache then
    -- Segment-dedup mode: accumulate per-segment weighted-average temperature.
    -- This matches what FluidRestoration.restore() will write on import (one packet
    -- per segment at avg_temp = energy/amount), preventing temperature key mismatches.
    for i = 1, #fluidbox do
      local seg_id = fluidbox.get_fluid_segment_id(i)
      if seg_id and not cache[seg_id] then
        -- First entity to claim this segment: read authoritative contents
        local contents = fluidbox.get_fluid_segment_contents(i)
        if contents then
          for fluid_name, amount in pairs(contents) do
            if amount > 0 then
              local local_fluid = fluidbox[i]
              local temp = (local_fluid and local_fluid.temperature) or 15
              log(string.format("[Fluid Export] Seg %d claimed by %s box %d: %s=%.1f temp=%.1f",
                  seg_id, entity.name, i, fluid_name, amount, temp))
              local engine_owned = engine_owned_segments[seg_id] == true
              cache[seg_id] = { fluid = fluid_name, amount = amount, temp = temp, engine_owned = engine_owned }
              table.insert(fluids, {
                name = fluid_name,
                amount = amount,
                temperature = temp,
                engine_owned = engine_owned
              })
            end
          end
        end
      elseif not seg_id then
        -- Fallback for isolated fluidboxes without a segment ID (e.g., machine
        -- internal buffers not connected to a pipe network). Read the local proxy
        -- directly — no dedup needed since there's no shared segment.
        local fluid = fluidbox[i]
        if fluid and fluid.amount and fluid.amount > 0 then
          log(string.format("[Fluid Export] Isolated %s box %d (no seg_id): %s=%.1f temp=%.1f",
              entity.name, i, fluid.name, fluid.amount, fluid.temperature or 15))
          table.insert(fluids, {
            name = fluid.name,
            amount = fluid.amount,
            temperature = fluid.temperature or 15,
            engine_owned = FluidOwnership.is_engine_owned_box(entity, i)
          })
        end
      elseif cache[seg_id] then
        -- Already seen this segment — log for diagnostics
        local local_fluid = fluidbox[i]
        if local_fluid and local_fluid.amount and local_fluid.amount > 0 then
          log(string.format("[Fluid Export] Seg %d already claimed, skipping %s box %d: local %s=%.1f",
              seg_id, entity.name, i, local_fluid.name, local_fluid.amount))
        end
      end
    end
  else
    -- Per-entity proxy mode (used for non-async scans like debug/validation)
    for i = 1, #fluidbox do
      local fluid = fluidbox[i]
      if fluid then
        table.insert(fluids, {
          name = fluid.name,
          amount = fluid.amount,
          temperature = fluid.temperature,
          engine_owned = FluidOwnership.is_engine_owned_box(entity, i)
        })
      end
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
