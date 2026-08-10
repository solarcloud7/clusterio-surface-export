local InventoryScanner = require("modules/surface_export/export_scanners/inventory-scanner")
local Util = require("modules/surface_export/utils/util")
local GameUtils = require("modules/surface_export/utils/game-utils")

local EntityHandlers = {}

EntityHandlers.skip_belt_items = false

function EntityHandlers.attach_missing_inventories(entity, data)
  data = data or {}
  if data.inventories == nil then
    local inventories = InventoryScanner.extract_all_inventories(entity)
    if #inventories > 0 then
      data.inventories = inventories
    end
  end
  return data
end

function EntityHandlers.extract_entity_burner(entity)
  local burner = entity.burner
  local currently_burning = nil
  local burning = burner.currently_burning
  if burning then
    local name = burning.name
    if type(name) ~= "string" and name then
      name = name.name
    end
    local quality = burning.quality
    if type(quality) ~= "string" and quality then
      quality = quality.name
    end
    currently_burning = {
      name = name,
      quality = quality or GameUtils.QUALITY_NORMAL
    }
  end
  return {
    currently_burning = currently_burning,
    remaining_burning_fuel = burner.remaining_burning_fuel
  }
end

function EntityHandlers.extract_common_state(entity, data)
  if entity.burner then
    data.burner = EntityHandlers.extract_entity_burner(entity)
  end

  -- intentional probe; failure expected on entities without an energy buffer, no log
  local energy_ok, energy = pcall(function() return entity.energy end)
  if energy_ok and energy and (entity.type == "accumulator" or energy > 0) then
    data.energy = energy
  end

  -- intentional probe; failure expected on non-heat entities, no log
  local temp_ok, temperature = pcall(function() return entity.temperature end)
  if temp_ok and temperature ~= nil then
    data.temperature = temperature
  end

  -- intentional probe; failure expected on entities without bonus production, no log
  local bp_ok, bonus_progress = pcall(function() return entity.bonus_progress end)
  if bp_ok and bonus_progress and bonus_progress > 0 then
    data.bonus_progress = bonus_progress
  end
end

function EntityHandlers.handle_entity(entity, category)
  local handler = EntityHandlers[category]
  local data
  if handler then
    data = handler(entity) or {}
  else
    data = {}

    data.fluidboxes = InventoryScanner.extract_fluidboxes(entity)
  end

  data = EntityHandlers.attach_missing_inventories(entity, data)

  EntityHandlers.extract_common_state(entity, data)

  if next(data) then
    return data
  end

  return nil
end

EntityHandlers["assembling-machine"] = function(entity)
  local data = {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }

  data.fluidboxes = InventoryScanner.extract_fluidboxes(entity)

  if entity.get_recipe then
    local recipe = entity.get_recipe()
    if recipe then
      data.recipe = recipe.name

      local proto = recipe.prototype
      if proto then
        data.recipe_overload_multiplier = proto.overload_multiplier
        data.recipe_allow_inserter_overload = proto.allow_inserter_overload
      end
    end
  end

  if entity.get_recipe then
    local _, recipe_quality = entity.get_recipe()
    if recipe_quality and recipe_quality.name ~= GameUtils.QUALITY_NORMAL then
      data.recipe_quality = recipe_quality.name
    end
  end

  if entity.crafting_progress then
    data.crafting_progress = entity.crafting_progress
  end

  if entity.productivity_bonus then
    data.productivity_bonus = entity.productivity_bonus
  end


  return data
end

EntityHandlers["furnace"] = function(entity)
  local data = {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }

  data.fluidboxes = InventoryScanner.extract_fluidboxes(entity)

  if entity.get_recipe then
    local recipe, recipe_quality = entity.get_recipe()
    if recipe then
      data.recipe = recipe.name

      local proto = recipe.prototype
      if proto then
        data.recipe_overload_multiplier = proto.overload_multiplier
        data.recipe_allow_inserter_overload = proto.allow_inserter_overload
      end
    end
    if recipe_quality and recipe_quality.name ~= GameUtils.QUALITY_NORMAL then
      data.recipe_quality = recipe_quality.name
    end
  end

  if entity.previous_recipe then
    data.previous_recipe = {
      name = entity.previous_recipe.name,
      quality = entity.previous_recipe.quality and entity.previous_recipe.quality.name or GameUtils.QUALITY_NORMAL
    }
  end

  if entity.crafting_progress then
    data.crafting_progress = entity.crafting_progress
  end

  return data
end

EntityHandlers["transport-belt"] = function(entity)
  return {
    items = EntityHandlers.skip_belt_items and {} or InventoryScanner.extract_belt_items(entity)
  }
end

EntityHandlers["underground-belt"] = function(entity)
  local data = {
    items = EntityHandlers.skip_belt_items and {} or InventoryScanner.extract_belt_items(entity),
    belt_to_ground_type = entity.belt_to_ground_type
  }


  return data
end

EntityHandlers["splitter"] = function(entity)
  local data = {
    items = EntityHandlers.skip_belt_items and {} or InventoryScanner.extract_belt_items(entity)
  }

  if entity.splitter_filter then
    local sf = entity.splitter_filter
    local quality = sf.quality
    if type(quality) ~= "string" and quality then
      quality = quality.name
    end
    data.filter = { name = sf.name, quality = quality or GameUtils.QUALITY_NORMAL }
  end

  if entity.splitter_input_priority then
    data.input_priority = entity.splitter_input_priority
  end
  if entity.splitter_output_priority then
    data.output_priority = entity.splitter_output_priority
  end

  return data
end

EntityHandlers["inserter"] = function(entity)
  local data = {}

  data.held_item = InventoryScanner.extract_inserter_held_item(entity)

  data.pickup_position = Util.round_position(entity.pickup_position, 2)
  data.drop_position = Util.round_position(entity.drop_position, 2)

  if entity.inserter_filter_mode then
    data.filter_mode = entity.inserter_filter_mode
  end
  
  data.use_filters = GameUtils.safe_get(entity, "use_filters")

  if entity.inserter_stack_size_override and entity.inserter_stack_size_override > 0 then
    data.stack_size_override = entity.inserter_stack_size_override
  end

  if entity.inserter_spoil_priority then
    data.spoil_priority = entity.inserter_spoil_priority
  end

  return data
end

EntityHandlers["container"] = function(entity)
  local data = {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }
  
  local bar_success, bar = pcall(function() 
    local inv = entity.get_inventory(defines.inventory.chest)
    return inv and inv.valid and inv.get_bar() or nil
  end)
  if not bar_success then log(string.format("[entity-handlers] read container bar failed on %s: %s", entity.name, tostring(bar))) end
  if bar_success and bar and bar < 65535 then
    data.bar = bar
  end
  
  return data
end

EntityHandlers["fluid-storage"] = function(entity)
  return {
    fluidboxes = InventoryScanner.extract_fluidboxes(entity)
  }
end

EntityHandlers["pipe"] = function(entity)
  return {
    fluidboxes = InventoryScanner.extract_fluidboxes(entity)
  }
end

EntityHandlers["pipe-to-ground"] = function(entity)
  return {
    fluidboxes = InventoryScanner.extract_fluidboxes(entity)
  }
end

EntityHandlers["pump"] = function(entity)
  local data = {
    fluidboxes = InventoryScanner.extract_fluidboxes(entity)
  }
  
  -- intentional probe; failure expected, no log
  local filter_success, fluid_filter = pcall(function() return entity.get_fluid_filter() end)
  if filter_success and fluid_filter then
    data.fluid_filter = fluid_filter.name
  end
  
  return data
end

EntityHandlers["train"] = function(entity)
  local data = {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }

  if entity.train and entity.type:find("locomotive") then
    data.schedule = entity.train.schedule
  end

  if entity.orientation then
    data.orientation = entity.orientation
  end

  if entity.train then
    data.train_id = entity.train.id
  end
  
  data.color = GameUtils.extract_color(entity)
  
  data.enable_logistics_while_moving = GameUtils.safe_get(entity, "enable_logistics_while_moving")
  
  data.copy_color_from_train_stop = GameUtils.safe_get(entity, "copy_color_from_train_stop")

  if entity.grid and entity.grid.valid and #entity.grid.equipment > 0 then
    data.equipment_grid = InventoryScanner.extract_equipment_grid(entity.grid)
  end

  return data
end

EntityHandlers["car"] = function(entity)
  local data = {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }

  if entity.grid and entity.grid.valid and #entity.grid.equipment > 0 then
    data.equipment_grid = InventoryScanner.extract_equipment_grid(entity.grid)
  end
  
  data.enable_logistics_while_moving = GameUtils.safe_get(entity, "enable_logistics_while_moving")
  
  data.driver_is_gunner = GameUtils.safe_get(entity, "driver_is_gunner")
  
  -- intentional probe; failure expected, no log
  local gun_success, selected_gun_index = pcall(function() return entity.selected_gun_index end)
  if gun_success and selected_gun_index then
    data.selected_gun_index = selected_gun_index
  end
  
  if entity.orientation then
    data.orientation = entity.orientation
  end
  
  data.color = GameUtils.extract_color(entity)

  return data
end

EntityHandlers["spider-vehicle"] = function(entity)
  local data = {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }

  if entity.grid and entity.grid.valid and #entity.grid.equipment > 0 then
    data.equipment_grid = InventoryScanner.extract_equipment_grid(entity.grid)
  end

  if entity.autopilot_destination then
    data.autopilot_destination = entity.autopilot_destination
  end
  
  -- intentional probe; failure expected, no log
  local targeting_success, auto_targeting = pcall(function() return entity.vehicle_automatic_targeting_parameters end)
  if targeting_success and auto_targeting then
    data.automatic_targeting_parameters = {
      auto_targeting_without_gunner = auto_targeting.auto_targeting_without_gunner,
      auto_targeting_with_gunner = auto_targeting.auto_targeting_with_gunner
    }
  end
  
  -- intentional probe; failure expected, no log
  local gun_success, selected_gun_index = pcall(function() return entity.selected_gun_index end)
  if gun_success and selected_gun_index then
    data.selected_gun_index = selected_gun_index
  end
  
  data.driver_is_gunner = GameUtils.safe_get(entity, "driver_is_gunner")
  
  data.enable_logistics_while_moving = GameUtils.safe_get(entity, "enable_logistics_while_moving")
  
  data.color = GameUtils.extract_color(entity)
  
  -- intentional probe; failure expected, no log
  local label_success, label = pcall(function() return entity.label end)
  if label_success and label and label ~= "" then
    data.label = label
  end

  return data
end

EntityHandlers["combinator"] = function(entity)
  local data = {}
  
  -- intentional probe; failure expected, no log
  local desc_success, description = pcall(function() return entity.entity_description end)
  if desc_success and description and description ~= "" then
    data.player_description = description
  end

  local cb = entity.get_control_behavior()
  if cb then
    -- intentional probe; failure expected, no log
    local success, params = pcall(function() return cb.parameters end)
    if success and params then
      data.parameters = params
    end

    if entity.type == "decider-combinator" then
      local sig_ok, sigs = pcall(function() return cb.signals_last_tick end)
      if not sig_ok then
        log(string.format("[EntityHandlers] signals_last_tick read failed on %s: %s",
          entity.name, tostring(sigs)))
      elseif sigs and #sigs > 0 then
        local captured = {}
        for _, s in pairs(sigs) do
          captured[#captured + 1] = { signal = s.signal, count = s.count }
        end
        data.output_signals = captured
      end
    end

  end

  return data
end

EntityHandlers["turret"] = function(entity)
  local data = {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }
  
  -- intentional probe; failure expected, no log
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
  
  data.ignore_unprioritised_targets = GameUtils.safe_get(entity, "ignore_unprioritised_targets")
  
  local cb = entity.get_control_behavior()
  if cb then
    -- intentional probe; failure expected, no log
    local success, ignore_condition = pcall(function() return cb.ignore_unlisted_targets_condition end)
    if success and ignore_condition then
      data.ignore_unlisted_targets_condition = ignore_condition
    end
    
    -- intentional probe; failure expected, no log
    local success2, set_ignore = pcall(function() return cb.set_ignore_unlisted_targets end)
    if success2 and set_ignore then
      data.set_ignore_unlisted_targets = set_ignore
    end
    
    -- intentional probe; failure expected, no log
    local success3, set_priority = pcall(function() return cb.set_priority_list end)
    if success3 and set_priority then
      data.set_priority_list = set_priority
    end
    
    -- intentional probe; failure expected, no log
    local success4, read_ammo = pcall(function() return cb.read_ammo end)
    if success4 and read_ammo then
      data.read_ammo = read_ammo
    end
  end
  
  return data
end

EntityHandlers["resource"] = function(entity)
  return { amount = entity.amount }
end

EntityHandlers["mining-drill"] = function(entity)
  local data = {
    inventories = InventoryScanner.extract_all_inventories(entity),
    fluidboxes = InventoryScanner.extract_fluidboxes(entity)
  }

  -- intentional probe; not every mining-drill prototype exposes these, absence is not a finding
  local mp_ok, mining_progress = pcall(function() return entity.mining_progress end)
  if mp_ok and mining_progress and mining_progress > 0 then
    data.mining_progress = mining_progress
  end
  -- intentional probe; same rationale as mining_progress
  local bmp_ok, bonus_mining_progress = pcall(function() return entity.bonus_mining_progress end)
  if bmp_ok and bonus_mining_progress and bonus_mining_progress > 0 then
    data.bonus_mining_progress = bonus_mining_progress
  end

  if entity.mining_target then
    data.mining_target = {
      name = entity.mining_target.name,
      position = Util.round_position(entity.mining_target.position, 2)
    }
  end

  if entity.drop_target then
    data.drop_target = Util.round_position(entity.drop_target.position, 2)
  end
  
  if (entity.filter_slot_count or 0) > 0 then
    local filter_success, filter = pcall(function() return entity.get_filter(1) end)
    if not filter_success then
      log(string.format("[EntityHandlers] mining-drill get_filter(1) failed on %s: %s",
        entity.name, tostring(filter)))
    elseif filter then
      local name = filter
      if type(name) ~= "string" then
        name = filter.name
        if type(name) ~= "string" and name then name = name.name end
      end
      if name then
        data.filter = { name = name }
      end
    end
  end

  return data
end

EntityHandlers["lab"] = function(entity)
  return {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }
end

EntityHandlers["roboport"] = function(entity)
  return {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }
end

EntityHandlers["artillery-turret"] = function(entity)
  local data = {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }
  
  data.artillery_auto_targeting = GameUtils.safe_get(entity, "artillery_auto_targeting")
  
  return data
end

EntityHandlers["rocket-silo"] = function(entity)
  local data = {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }
  
  if entity.get_recipe then
    local recipe, recipe_quality = entity.get_recipe()
    if recipe then
      data.recipe = recipe.name
    end
    if recipe_quality and recipe_quality.name ~= GameUtils.QUALITY_NORMAL then
      data.recipe_quality = recipe_quality.name
    end
  end

  if entity.rocket_parts then
    data.rocket_parts = entity.rocket_parts
  end

  if entity.auto_launch ~= nil then
    data.auto_launch = entity.auto_launch
  end

  return data
end

EntityHandlers["gate"] = function(entity)
  local data = {}
  
  if entity.opened ~= nil then
    data.opened = entity.opened
  end
  
  return next(data) and data or nil
end

EntityHandlers["power-switch"] = function(entity)
  local data = {}
  
  data.switch_state = GameUtils.safe_get(entity, "power_switch_state")
  
  return next(data) and data or nil
end

EntityHandlers["agricultural-tower"] = function(entity)
  local data = {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }
  
  if entity.planting_position then
    data.planting_position = entity.planting_position
  end
  
  return data
end

EntityHandlers["programmable-speaker"] = function(entity)
  local data = {}
  
  
  return next(data) and data or nil
end

EntityHandlers["lamp"] = function(entity)
  local data = {}
  
  data.color = GameUtils.extract_color(entity)
  
  data.always_on = GameUtils.safe_get(entity, "always_on")
  
  
  return next(data) and data or nil
end

EntityHandlers["entity-ghost"] = function(entity)
  local data = {
    ghost_name = entity.ghost_name,
    ghost_type = entity.ghost_type
  }
  
  if entity.item_requests then
    data.item_requests = {}
    for _, req in pairs(entity.item_requests) do
      table.insert(data.item_requests, {
        item = req.name,
        quality = req.quality,
        count = req.count
      })
    end
  end

  if entity.quality and entity.quality.name ~= GameUtils.QUALITY_NORMAL then
    data.ghost_quality = entity.quality.name
  end
  
  return data
end

EntityHandlers["tile-ghost"] = function(entity)
  local data = {
    ghost_name = entity.ghost_name
  }
  
  
  return data
end

EntityHandlers["item-request-proxy"] = function(entity)
  local data = {}
  
  if entity.item_requests then
    data.item_requests = {}
    for _, req in pairs(entity.item_requests) do
      table.insert(data.item_requests, {
        item = req.name,
        quality = req.quality,
        count = req.count
      })
    end
  end
  
  if entity.insert_plan and #entity.insert_plan > 0 then
    data.insert_plan = entity.insert_plan
  end
  
  if entity.proxy_target and entity.proxy_target.valid then
    data.target_position = Util.round_position(entity.proxy_target.position, 2)
    data.target_name = entity.proxy_target.name
  end
  
  return next(data) and data or nil
end

EntityHandlers["space-platform-hub"] = function(entity)
  local data = {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }
  data.providing_to_other_platforms = GameUtils.safe_get(entity, "providing_to_other_platforms")
  data.request_missing_construction_materials = GameUtils.safe_get(entity, "request_missing_construction_materials")
  data.request_from_buffers = GameUtils.safe_get(entity, "request_from_buffers")
  return data
end

EntityHandlers["display-panel"] = function(entity)
  local data = {}
  data.display_panel_text = entity.display_panel_text
  data.display_panel_always_show = entity.display_panel_always_show
  data.display_panel_show_in_chart = entity.display_panel_show_in_chart
  local behavior = entity.get_control_behavior()
  if behavior and behavior.records and #behavior.records > 0 then
    data.display_panel_messages = behavior.records
  end
  return next(data) and data or nil
end

EntityHandlers["train-stop"] = function(entity)
  local data = {}
  
  
  data.color = GameUtils.extract_color(entity)
  
  -- intentional probe; failure expected, no log
  local limit_success, trains_limit = pcall(function() return entity.trains_limit end)
  if limit_success and trains_limit then
    data.manual_trains_limit = trains_limit
  end
  
  -- intentional probe; failure expected, no log
  local priority_success, priority = pcall(function() return entity.priority end)
  if priority_success and priority then
    data.priority = priority
  end
  
  return next(data) and data or nil
end

return EntityHandlers
