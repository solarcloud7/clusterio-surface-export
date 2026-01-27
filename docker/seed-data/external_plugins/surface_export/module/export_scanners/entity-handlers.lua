-- FactorioSurfaceExport - Entity Handlers
-- Per-entity-type serialization handlers

local InventoryScanner = require("modules/surface_export/export_scanners/inventory-scanner")
local Util = require("modules/surface_export/utils/util")

local EntityHandlers = {}

--- Main dispatcher for entity-specific data extraction
--- @param entity LuaEntity: The entity to handle
--- @param category string: Entity category (from Util.get_entity_category)
--- @return table|nil: Entity-specific data, or nil if no special handling needed
function EntityHandlers.handle_entity(entity, category)
  local handler = EntityHandlers[category]
  if handler then
    return handler(entity)
  end

  -- Default: extract inventories AND fluids if present
  -- This ensures entities without specific handlers still have their contents captured
  local data = {}
  
  local inventories = InventoryScanner.extract_all_inventories(entity)
  if #inventories > 0 then
    data.inventories = inventories
  end
  
  local fluids = InventoryScanner.extract_fluids(entity)
  if #fluids > 0 then
    data.fluids = fluids
  end
  
  if next(data) then
    return data
  end

  return nil
end

--- Assembling machine handler
EntityHandlers["assembling-machine"] = function(entity)
  local data = {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }

  -- Recipe
  if entity.get_recipe then
    local recipe = entity.get_recipe()
    if recipe then
      data.recipe = recipe.name
      
      -- Capture recipe properties that affect inventory limits (for validation)
      -- overload_multiplier determines how many extra items inserters put in
      -- allow_inserter_overload determines if stack bonus applies
      local proto = recipe.prototype
      if proto then
        data.recipe_overload_multiplier = proto.overload_multiplier
        data.recipe_allow_inserter_overload = proto.allow_inserter_overload
      end
    end
  end
  
  -- RECIPE QUALITY (Factorio 2.0+)
  local recipe_quality_success, recipe_quality = pcall(function() return entity.get_recipe_quality() end)
  if recipe_quality_success and recipe_quality and recipe_quality.name ~= "normal" then
    data.recipe_quality = recipe_quality.name
  end

  -- Crafting progress
  if entity.crafting_progress then
    data.crafting_progress = entity.crafting_progress
  end

  -- Productivity bonus
  if entity.productivity_bonus then
    data.productivity_bonus = entity.productivity_bonus
  end

  -- Bonus progress
  if entity.bonus_progress then
    data.bonus_progress = entity.bonus_progress
  end

  return data
end

--- Furnace handler
EntityHandlers["furnace"] = function(entity)
  local data = {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }

  -- Recipe (smelting recipe)
  if entity.get_recipe then
    local recipe = entity.get_recipe()
    if recipe then
      data.recipe = recipe.name
      
      -- Capture recipe properties that affect inventory limits (for validation)
      -- This is especially important for foundries which have complex recipes
      local proto = recipe.prototype
      if proto then
        data.recipe_overload_multiplier = proto.overload_multiplier
        data.recipe_allow_inserter_overload = proto.allow_inserter_overload
      end
    end
  end

  -- Previous recipe (Factorio 2.0+ - for foundries and other furnaces)
  if entity.previous_recipe then
    data.previous_recipe = {
      name = entity.previous_recipe.name,
      quality = entity.previous_recipe.quality and entity.previous_recipe.quality.name or "normal"
    }
  end

  -- Smelting progress
  if entity.crafting_progress then
    data.crafting_progress = entity.crafting_progress
  end

  return data
end

--- Transport belt handler
EntityHandlers["transport-belt"] = function(entity)
  return {
    items = InventoryScanner.extract_belt_items(entity)
  }
end

--- Underground belt handler
EntityHandlers["underground-belt"] = function(entity)
  local data = {
    items = InventoryScanner.extract_belt_items(entity),
    belt_to_ground_type = entity.belt_to_ground_type  -- "input" or "output"
  }

  -- Connection partner (for verification)
  if entity.neighbours then
    data.has_partner = true
  end

  return data
end

--- Splitter handler
EntityHandlers["splitter"] = function(entity)
  local data = {
    items = InventoryScanner.extract_belt_items(entity)
  }

  -- Filter settings
  if entity.splitter_filter then
    data.filter = entity.splitter_filter.name
  end

  -- Input/output priority
  if entity.splitter_input_priority then
    data.input_priority = entity.splitter_input_priority
  end
  if entity.splitter_output_priority then
    data.output_priority = entity.splitter_output_priority
  end

  return data
end

--- Inserter handler
EntityHandlers["inserter"] = function(entity)
  local data = {}

  -- Held item (if any)
  data.held_item = InventoryScanner.extract_inserter_held_item(entity)

  -- Pickup and drop positions
  data.pickup_position = Util.round_position(entity.pickup_position, 2)
  data.drop_position = Util.round_position(entity.drop_position, 2)

  -- Filter mode (whitelist/blacklist)
  if entity.inserter_filter_mode then
    data.filter_mode = entity.inserter_filter_mode  -- "whitelist" or "blacklist"
  end
  
  -- USE FILTERS flag - Whether filtering is enabled/active
  local use_filters_success, use_filters = pcall(function() return entity.use_filters end)
  if use_filters_success and use_filters ~= nil then
    data.use_filters = use_filters
  end

  -- Stack size override (0 = no override)
  if entity.inserter_stack_size_override and entity.inserter_stack_size_override > 0 then
    data.stack_size_override = entity.inserter_stack_size_override
  end

  -- Spoil priority (Factorio 2.0 Space Age)
  if entity.inserter_spoil_priority then
    data.spoil_priority = entity.inserter_spoil_priority  -- "spoiled-first", "fresh-first", "any"
  end

  return data
end

--- Container (chest) handler
EntityHandlers["container"] = function(entity)
  local data = {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }
  
  -- BAR position (inventory limit)
  local bar_success, bar = pcall(function() 
    local inv = entity.get_inventory(defines.inventory.chest)
    return inv and inv.valid and inv.get_bar() or nil
  end)
  if bar_success and bar and bar < 65535 then  -- 65535 is "no bar"
    data.bar = bar
  end
  
  return data
end

--- Fluid storage (tanks) handler
EntityHandlers["fluid-storage"] = function(entity)
  return {
    fluids = InventoryScanner.extract_fluids(entity)
  }
end

--- Pipe handler
EntityHandlers["pipe"] = function(entity)
  return {
    fluids = InventoryScanner.extract_fluids(entity)
  }
end

--- Underground pipe handler
EntityHandlers["pipe-to-ground"] = function(entity)
  return {
    fluids = InventoryScanner.extract_fluids(entity)
  }
end

--- Pump handler
EntityHandlers["pump"] = function(entity)
  local data = {
    fluids = InventoryScanner.extract_fluids(entity)
  }
  
  -- FLUID FILTER
  local filter_success, fluid_filter = pcall(function() return entity.get_fluid_filter() end)
  if filter_success and fluid_filter then
    data.fluid_filter = fluid_filter.name
  end
  
  return data
end

--- Train (locomotive/wagon) handler
EntityHandlers["train"] = function(entity)
  local data = {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }

  -- Train schedule (only for locomotives)
  if entity.train and entity.type:find("locomotive") then
    data.schedule = entity.train.schedule
  end

  -- Orientation
  if entity.orientation then
    data.orientation = entity.orientation
  end

  -- Train ID (for matching during import)
  if entity.train then
    data.train_id = entity.train.id
  end
  
  -- COLOR (locomotives and wagons)
  local color_success, color = pcall(function() return entity.color end)
  if color_success and color then
    data.color = {
      r = color.r or 0,
      g = color.g or 0,
      b = color.b or 0,
      a = color.a or 1
    }
  end
  
  -- ENABLE LOGISTICS WHILE MOVING (locomotives and wagons)
  local logistics_success, enable_logistics = pcall(function() return entity.enable_logistics_while_moving end)
  if logistics_success and enable_logistics ~= nil then
    data.enable_logistics_while_moving = enable_logistics
  end
  
  -- COPY COLOR FROM TRAIN STOP (locomotives and wagons)
  local copy_color_success, copy_color = pcall(function() return entity.copy_color_from_train_stop end)
  if copy_color_success and copy_color ~= nil then
    data.copy_color_from_train_stop = copy_color
  end

  -- Equipment grid (locomotives can have equipment in Space Age)
  if entity.grid and entity.grid.valid and #entity.grid.equipment > 0 then
    data.equipment_grid = InventoryScanner.extract_equipment_grid(entity.grid)
  end

  return data
end

--- Car/Tank handler
EntityHandlers["car"] = function(entity)
  local data = {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }

  -- Equipment grid (cars and tanks can have equipment grids)
  if entity.grid and entity.grid.valid and #entity.grid.equipment > 0 then
    data.equipment_grid = InventoryScanner.extract_equipment_grid(entity.grid)
  end
  
  -- ENABLE LOGISTICS WHILE MOVING
  local logistics_success, enable_logistics = pcall(function() return entity.enable_logistics_while_moving end)
  if logistics_success and enable_logistics ~= nil then
    data.enable_logistics_while_moving = enable_logistics
  end
  
  -- DRIVER IS MAIN GUNNER
  local gunner_success, driver_is_main_gunner = pcall(function() return entity.driver_is_main_gunner end)
  if gunner_success and driver_is_main_gunner ~= nil then
    data.driver_is_main_gunner = driver_is_main_gunner
  end
  
  -- SELECTED GUN INDEX
  local gun_success, selected_gun_index = pcall(function() return entity.selected_gun_index end)
  if gun_success and selected_gun_index then
    data.selected_gun_index = selected_gun_index
  end
  
  -- ORIENTATION
  if entity.orientation then
    data.orientation = entity.orientation
  end
  
  -- COLOR
  local color_success, color = pcall(function() return entity.color end)
  if color_success and color then
    data.color = {
      r = color.r or 0,
      g = color.g or 0,
      b = color.b or 0,
      a = color.a or 1
    }
  end

  return data
end

--- Spider vehicle (Spidertron) handler
EntityHandlers["spider-vehicle"] = function(entity)
  local data = {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }

  -- Equipment grid (spidertrons always have equipment grids)
  if entity.grid and entity.grid.valid and #entity.grid.equipment > 0 then
    data.equipment_grid = InventoryScanner.extract_equipment_grid(entity.grid)
  end

  -- Autopilot destination
  if entity.autopilot_destination then
    data.autopilot_destination = entity.autopilot_destination
  end
  
  -- AUTOMATIC TARGETING PARAMETERS (critical for combat configuration)
  local targeting_success, auto_targeting = pcall(function() return entity.vehicle_automatic_targeting_parameters end)
  if targeting_success and auto_targeting then
    data.automatic_targeting_parameters = {
      auto_targeting_without_gunner = auto_targeting.auto_targeting_without_gunner,
      auto_targeting_with_gunner = auto_targeting.auto_targeting_with_gunner
    }
  end
  
  -- SELECTED GUN INDEX
  local gun_success, selected_gun_index = pcall(function() return entity.selected_gun_index end)
  if gun_success and selected_gun_index then
    data.selected_gun_index = selected_gun_index
  end
  
  -- DRIVER IS MAIN GUNNER
  local gunner_success, driver_is_main_gunner = pcall(function() return entity.driver_is_main_gunner end)
  if gunner_success and driver_is_main_gunner ~= nil then
    data.driver_is_main_gunner = driver_is_main_gunner
  end
  
  -- ENABLE LOGISTICS WHILE MOVING
  local logistics_success, enable_logistics = pcall(function() return entity.enable_logistics_while_moving end)
  if logistics_success and enable_logistics ~= nil then
    data.enable_logistics_while_moving = enable_logistics
  end
  
  -- COLOR
  local color_success, color = pcall(function() return entity.color end)
  if color_success and color then
    data.color = {
      r = color.r or 0,
      g = color.g or 0,
      b = color.b or 0,
      a = color.a or 1
    }
  end
  
  -- LABEL (spider name)
  local label_success, label = pcall(function() return entity.label end)
  if label_success and label and label ~= "" then
    data.label = label
  end

  return data
end

--- Combinator handler
EntityHandlers["combinator"] = function(entity)
  local data = {}
  
  -- PLAYER DESCRIPTION (user-set description for arithmetic/decider/selector combinators)
  local desc_success, description = pcall(function() return entity.entity_description end)
  if desc_success and description and description ~= "" then
    data.player_description = description
  end

  local cb = entity.get_control_behavior()
  if cb then
    -- Try to get parameters (exists for arithmetic/decider combinators, not constant)
    local success, params = pcall(function() return cb.parameters end)
    if success and params then
      data.parameters = params
    end

    -- Other combinator types can be added here
  end

  return data
end

--- Turret handler
-- Factorio 2.0 turret priority targeting API:
-- LuaEntity properties:
--   - priority_targets (read-only array[LuaEntityPrototype]): current priority list
--   - get_priority_target(index) -> LuaEntityPrototype?: read single entry
--   - set_priority_target(index, entity_id?): write single entry
--   - ignore_unprioritised_targets (RW boolean): whether to only shoot prioritised targets
-- LuaTurretControlBehavior (circuit control):
--   - set_priority_list (boolean): enables circuit-controlled priorities from signals
--   - set_ignore_unlisted_targets (boolean): enables ignoring unlisted targets via circuit
--   - ignore_unlisted_targets_condition: circuit condition for ignoring
--   - read_ammo (boolean): turret sends ammo count to circuit network
EntityHandlers["turret"] = function(entity)
  local data = {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }
  
  -- Priority targets (entity's own priority list - not circuit controlled)
  local priority_success, priority_targets = pcall(function() return entity.priority_targets end)
  if priority_success and priority_targets and #priority_targets > 0 then
    data.priority_targets = {}
    for i, target_proto in ipairs(priority_targets) do
      table.insert(data.priority_targets, {
        index = i,
        name = target_proto.name
      })
    end
  end
  
  -- Whether turret ignores non-prioritised targets
  local ignore_success, ignore_unprioritised = pcall(function() return entity.ignore_unprioritised_targets end)
  if ignore_success and ignore_unprioritised ~= nil then
    data.ignore_unprioritised_targets = ignore_unprioritised
  end
  
  -- Turret control behavior (circuit-controlled targeting)
  local cb = entity.get_control_behavior()
  if cb then
    -- Circuit conditions for ignoring unlisted targets
    local success, ignore_condition = pcall(function() return cb.ignore_unlisted_targets_condition end)
    if success and ignore_condition then
      data.ignore_unlisted_targets_condition = ignore_condition
    end
    
    -- Whether to ignore unlisted targets based on circuit
    local success2, set_ignore = pcall(function() return cb.set_ignore_unlisted_targets end)
    if success2 and set_ignore then
      data.set_ignore_unlisted_targets = set_ignore
    end
    
    -- Whether to set priority list from circuit signals
    local success3, set_priority = pcall(function() return cb.set_priority_list end)
    if success3 and set_priority then
      data.set_priority_list = set_priority
    end
    
    -- Read ammo to circuit
    local success4, read_ammo = pcall(function() return cb.read_ammo end)
    if success4 and read_ammo then
      data.read_ammo = read_ammo
    end
  end
  
  return data
end

--- Mining drill handler
EntityHandlers["mining-drill"] = function(entity)
  local data = {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }

  -- Mining target
  if entity.mining_target then
    data.mining_target = {
      name = entity.mining_target.name,
      position = Util.round_position(entity.mining_target.position, 2)
    }
  end

  -- Drop target (output position)
  if entity.drop_target then
    data.drop_target = Util.round_position(entity.drop_target.position, 2)
  end
  
  -- FILTER (resource filter for mining drills)
  local filter_success, filter = pcall(function() return entity.get_filter() end)
  if filter_success and filter then
    data.filter = {
      name = filter.name,
      quality = filter.quality and filter.quality.name or "normal"
    }
  end

  return data
end

--- Lab handler
EntityHandlers["lab"] = function(entity)
  return {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }
end

--- Roboport handler
EntityHandlers["roboport"] = function(entity)
  return {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }
end

--- Artillery turret handler
EntityHandlers["artillery-turret"] = function(entity)
  local data = {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }
  
  -- ARTILLERY AUTO TARGETING
  local auto_target_success, auto_targeting = pcall(function() return entity.artillery_auto_targeting end)
  if auto_target_success and auto_targeting ~= nil then
    data.artillery_auto_targeting = auto_targeting
  end
  
  return data
end

EntityHandlers["rocket-silo"] = function(entity)
  local data = {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }
  
  -- RECIPE
  if entity.get_recipe then
    local recipe = entity.get_recipe()
    if recipe then
      data.recipe = recipe.name
    end
  end
  
  -- RECIPE QUALITY (Factorio 2.0+)
  local recipe_quality_success, recipe_quality = pcall(function() return entity.get_recipe_quality() end)
  if recipe_quality_success and recipe_quality and recipe_quality.name ~= "normal" then
    data.recipe_quality = recipe_quality.name
  end

  -- Rocket parts
  if entity.rocket_parts then
    data.rocket_parts = entity.rocket_parts
  end

  -- Auto-launch setting
  if entity.auto_launch ~= nil then
    data.auto_launch = entity.auto_launch
  end

  return data
end

--- Gate handler
EntityHandlers["gate"] = function(entity)
  local data = {}
  
  -- Gate open state
  if entity.opened ~= nil then
    data.opened = entity.opened
  end
  
  return next(data) and data or nil
end

--- Power switch handler
EntityHandlers["power-switch"] = function(entity)
  local data = {}
  
  -- SWITCH STATE (on/off)
  local switch_success, switch_state = pcall(function() return entity.power_switch_state end)
  if switch_success and switch_state ~= nil then
    data.switch_state = switch_state
  end
  
  return next(data) and data or nil
end

--- Agricultural tower handler (Space Age)
EntityHandlers["agricultural-tower"] = function(entity)
  local data = {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }
  
  -- Planting position
  if entity.planting_position then
    data.planting_position = entity.planting_position
  end
  
  return data
end

--- Programmable speaker handler
EntityHandlers["programmable-speaker"] = function(entity)
  local data = {}
  
  -- Control behavior will be captured by ConnectionScanner
  -- but we can add any speaker-specific state here
  
  return next(data) and data or nil
end

--- Lamp handler
EntityHandlers["lamp"] = function(entity)
  local data = {}
  
  -- COLOR
  local color_success, color = pcall(function() return entity.color end)
  if color_success and color then
    data.color = {
      r = color.r or 0,
      g = color.g or 0,
      b = color.b or 0,
      a = color.a or 1
    }
  end
  
  -- ALWAYS ON setting
  local always_on_success, always_on = pcall(function() return entity.always_on end)
  if always_on_success and always_on ~= nil then
    data.always_on = always_on
  end
  
  -- Control behavior (use_colors) will be captured by ConnectionScanner
  
  return next(data) and data or nil
end

--- Entity ghost handler (blueprinted entities not yet built)
EntityHandlers["entity-ghost"] = function(entity)
  local data = {
    ghost_name = entity.ghost_name,
    ghost_type = entity.ghost_type
  }
  
  -- Capture item requests for this ghost
  if entity.item_requests then
    data.item_requests = {}
    for item_with_quality, count in pairs(entity.item_requests) do
      table.insert(data.item_requests, {
        item = item_with_quality.name,
        quality = item_with_quality.quality,
        count = count
      })
    end
  end
  
  -- Ghost quality
  if entity.quality and entity.quality.name ~= "normal" then
    data.ghost_quality = entity.quality.name
  end
  
  return data
end

--- Tile ghost handler (blueprinted tiles not yet placed)
EntityHandlers["tile-ghost"] = function(entity)
  local data = {
    ghost_name = entity.ghost_name
  }
  
  -- Tile ghosts don't have as many properties as entity ghosts
  -- but we still need the ghost_name to recreate them
  
  return data
end

--- Item request proxy handler (construction material requests)
EntityHandlers["item-request-proxy"] = function(entity)
  local data = {}
  
  -- Capture item requests
  if entity.item_requests then
    data.item_requests = {}
    for item_with_quality, count in pairs(entity.item_requests) do
      table.insert(data.item_requests, {
        item = item_with_quality.name,
        quality = item_with_quality.quality,
        count = count
      })
    end
  end
  
  -- Capture insert plan (inventory positions for items)
  if entity.insert_plan and #entity.insert_plan > 0 then
    data.insert_plan = entity.insert_plan
  end
  
  -- Target entity position (the entity this proxy is for)
  if entity.proxy_target and entity.proxy_target.valid then
    data.target_position = Util.round_position(entity.proxy_target.position, 2)
  end
  
  return next(data) and data or nil
end

--- Train stop handler
EntityHandlers["train-stop"] = function(entity)
  local data = {}
  
  -- Station name (already captured in entity_data.backer_name by entity-scanner)
  
  -- COLOR
  local color_success, color = pcall(function() return entity.color end)
  if color_success and color then
    data.color = {
      r = color.r or 0,
      g = color.g or 0,
      b = color.b or 0,
      a = color.a or 1
    }
  end
  
  -- MANUAL TRAINS LIMIT
  local limit_success, trains_limit = pcall(function() return entity.trains_limit end)
  if limit_success and trains_limit then
    data.manual_trains_limit = trains_limit
  end
  
  -- PRIORITY
  local priority_success, priority = pcall(function() return entity.priority end)
  if priority_success and priority then
    data.priority = priority
  end
  
  return next(data) and data or nil
end

return EntityHandlers
