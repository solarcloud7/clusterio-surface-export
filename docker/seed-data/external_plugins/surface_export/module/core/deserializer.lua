-- FactorioSurfaceExport - Deserializer
-- Import/restore platform state from JSON

local Util = require("modules/surface_export/utils/util")
local Verification = require("modules/surface_export/validators/verification")

local Deserializer = {}

--- Safe call wrapper that logs errors but doesn't crash
--- @param context string: Description of what we're trying to do
--- @param func function: Function to call
--- @return boolean: true if successful, false if error
local function safe_call(context, func)
  local ok, err = pcall(func)
  if not ok then
    log(string.format("[Deserializer Error] %s: %s", context, tostring(err)))
  end
  return ok
end

--- Import a platform from JSON file
--- 9-step atomic import process
--- @param filename string: Filename in script-output directory
--- @param target_surface LuaSurface: Surface to import to
--- @return boolean, string|nil: success flag and error message if failed
function Deserializer.import_platform(filename, target_surface)
  if not target_surface or not target_surface.valid then
    return false, "Invalid target surface"
  end

  -- Step 1: Read file
  game.print(string.format("Reading file: %s", filename))
  local json_string, read_error = Util.read_file_compat(filename)
  if not json_string or #json_string == 0 then
    if read_error then
      return false, string.format("Unable to read '%s': %s", filename, read_error)
    end
    return false, string.format("File not found or empty: %s", filename)
  end

  -- Step 2: Parse JSON
  game.print("Parsing JSON...")
  local import_data, parse_error = Util.json_to_table_compat(json_string)
  if not import_data then
    local reason = parse_error or "Invalid JSON"
    return false, string.format("JSON parsing failed: %s", reason)
  end

  -- Step 3: Verify integrity
  game.print("Verifying data integrity...")
  local valid, error = Verification.verify_export(import_data)
  if not valid then
    return false, string.format("Import data verification failed: %s", error)
  end

  -- Step 4: Clear surface (ask for confirmation in production!)
  -- For now, we'll warn if surface is not empty
  local existing_entities = target_surface.find_entities_filtered({})
  if #existing_entities > 0 then
    game.print(string.format("Warning: Target surface has %d existing entities", #existing_entities))
    -- In production, you might want to add a confirmation step here
  end

  log(string.format("[FactorioSurfaceExport] Starting import to surface %d (%d entities)",
    target_surface.index, #import_data.entities))

  -- Step 5: Create entities
  game.print(string.format("Creating %d entities...", #import_data.entities))
  local entity_map = {}  -- Maps old entity_id to new entity
  local created_count = 0
  local failed_count = 0

  for _, entity_data in ipairs(import_data.entities) do
    -- Skip items on ground for now, handle them separately
    if entity_data.type ~= "item-on-ground" then
      local created_entity = Deserializer.create_entity(target_surface, entity_data)

      if created_entity then
        entity_map[entity_data.entity_id] = created_entity
        created_count = created_count + 1
      else
        failed_count = failed_count + 1
        log(string.format("[FactorioSurfaceExport] Failed to create entity: %s at %s",
          entity_data.name,
          serpent.line(entity_data.position)))
      end
    end
  end

  game.print(string.format("  Created: %d, Failed: %d", created_count, failed_count))

  -- Step 6: Restore entity states (recipes, settings)
  game.print("Restoring entity states...")
  for _, entity_data in ipairs(import_data.entities) do
    local entity = entity_map[entity_data.entity_id]
    if entity and entity.valid then
      Deserializer.restore_entity_state(entity, entity_data)
    end
  end

  -- Step 7: Restore inventories
  game.print("Restoring inventories...")
  for _, entity_data in ipairs(import_data.entities) do
    local entity = entity_map[entity_data.entity_id]
    if entity and entity.valid then
      Deserializer.restore_inventories(entity, entity_data)
    end
  end

  -- Step 8: Restore fluids
  game.print("Restoring fluids...")
  for _, entity_data in ipairs(import_data.entities) do
    local entity = entity_map[entity_data.entity_id]
    if entity and entity.valid then
      Deserializer.restore_fluids(entity, entity_data)
    end
  end

  -- Step 9: Restore control behavior (circuit conditions, filters)
  game.print("Restoring control behavior...")
  for _, entity_data in ipairs(import_data.entities) do
    local entity = entity_map[entity_data.entity_id]
    if entity and entity.valid then
      Deserializer.restore_control_behavior(entity, entity_data)
    end
  end

  -- Step 10: Restore logistic requests and entity filters
  game.print("Restoring logistics and filters...")
  for _, entity_data in ipairs(import_data.entities) do
    local entity = entity_map[entity_data.entity_id]
    if entity and entity.valid then
      Deserializer.restore_logistic_requests(entity, entity_data)
      Deserializer.restore_entity_filters(entity, entity_data)
    end
  end

  -- Step 11: Restore circuit connections (MUST be after all entities created)
  game.print("Restoring circuit connections...")
  for _, entity_data in ipairs(import_data.entities) do
    local entity = entity_map[entity_data.entity_id]
    if entity and entity.valid then
      Deserializer.restore_circuit_connections(entity, entity_data, entity_map)
    end
  end

  -- Step 12: Restore power connections (copper cables between poles)
  game.print("Restoring power connections...")
  for _, entity_data in ipairs(import_data.entities) do
    local entity = entity_map[entity_data.entity_id]
    if entity and entity.valid then
      Deserializer.restore_power_connections(entity, entity_data, entity_map)
    end
  end

  -- Step 13: Restore items on ground
  game.print("Restoring ground items...")
  for _, entity_data in ipairs(import_data.entities) do
    if entity_data.type == "item-on-ground" then
      Deserializer.create_ground_item(target_surface, entity_data)
    end
  end

  -- Step 14: Verify counts match
  game.print("Verifying import...")
  local final_counts = Verification.count_surface_items(target_surface)
  local expected_counts = import_data.verification.item_counts

  local success, report = Verification.generate_report(expected_counts, final_counts)

  if not success then
    game.print("WARNING: Item count verification found mismatches!")
    Verification.print_report(report)
  else
    game.print("Import verification passed!")
  end

  log(string.format("[FactorioSurfaceExport] Import complete to surface %d", target_surface.index))
  game.print("Import complete!")

  return true, import_data
end

--- Create a single entity on the surface
--- @param surface LuaSurface: Target surface
--- @param entity_data table: Serialized entity data
--- @return LuaEntity|nil: Created entity, or nil if failed
function Deserializer.create_entity(surface, entity_data)
  -- CRITICAL: Skip space-platform-hub - it's created automatically with the platform
  -- and can't be created manually. The async-processor maps it to entity_map separately.
  if entity_data.name == "space-platform-hub" then
    log("[Deserializer] Skipping space-platform-hub (created automatically with platform)")
    return nil
  end
  
  -- DEBUG: Log direction for crafting machines to debug direction issues
  if entity_data.type == "assembling-machine" or entity_data.type == "furnace" then
    log(string.format("[DEBUG] Creating %s at (%.1f, %.1f) with direction=%s (type=%s)",
      entity_data.name,
      entity_data.position.x or entity_data.position[1],
      entity_data.position.y or entity_data.position[2],
      tostring(entity_data.direction),
      type(entity_data.direction)))
  end
  
  local params = {
    name = entity_data.name,
    position = entity_data.position,
    direction = entity_data.direction or defines.direction.north,
    force = entity_data.force or "player",
    create_build_effect_smoke = false,
    raise_built = false
  }

  -- Add orientation for trains/vehicles
  if entity_data.orientation then
    params.orientation = entity_data.orientation
  end

  -- Add quality during creation (read-only after creation in Factorio 2.0)
  if entity_data.quality then
    params.quality = entity_data.quality
  end

  -- Add underground belt type (must be set during creation)
  if entity_data.type == "underground-belt" and entity_data.specific_data then
    params.type = entity_data.specific_data.belt_to_ground_type  -- "input" or "output"
  end

  -- Handle ghost entities (entity-ghost, tile-ghost)
  if entity_data.type == "entity-ghost" and entity_data.specific_data then
    params.inner_name = entity_data.specific_data.ghost_name
    -- Ghost quality is separate from the ghost entity's quality
    if entity_data.specific_data.ghost_quality then
      params.quality = entity_data.specific_data.ghost_quality
    end
  elseif entity_data.type == "tile-ghost" and entity_data.specific_data then
    params.inner_name = entity_data.specific_data.ghost_name
  end

  local success, result = pcall(function()
    return surface.create_entity(params)
  end)

  if not success then
    log(string.format("[Deserializer Error] create_entity %s at (%.1f, %.1f): %s",
      entity_data.name,
      entity_data.position.x or entity_data.position[1] or 0,
      entity_data.position.y or entity_data.position[2] or 0,
      tostring(result)))
    return nil
  end
  
  local entity = result
  if not entity then
    return nil
  end

  -- CRITICAL: For crafting machines with fluid recipes (foundry, assemblers), 
  -- we MUST set the recipe immediately after creation so the game respects
  -- the direction/rotation for fluid port alignment. If recipe is set later,
  -- the fluid ports may not align correctly with the requested direction.
  if entity.valid and entity.set_recipe and entity_data.specific_data and entity_data.specific_data.recipe then
    local recipe_success = safe_call(
      string.format("set_recipe %s for %s", entity_data.specific_data.recipe, entity.name),
      function() entity.set_recipe(entity_data.specific_data.recipe) end
    )
    if recipe_success then
      -- After setting recipe, re-apply direction to ensure fluid ports align
      if entity_data.direction and entity.direction ~= entity_data.direction then
        entity.direction = entity_data.direction
      end
    end
  end

  -- DEBUG: Verify direction was applied for crafting machines
  if (entity_data.type == "assembling-machine" or entity_data.type == "furnace") and entity.valid then
    log(string.format("[DEBUG] Created %s - requested direction=%s, actual direction=%s, recipe=%s",
      entity_data.name,
      tostring(entity_data.direction),
      tostring(entity.direction),
      tostring(entity_data.specific_data and entity_data.specific_data.recipe or "none")))
  end

  -- Set health
  if entity_data.health and entity.health then
    entity.health = entity_data.health
  end

  return entity
end

--- Restore entity-specific state (recipes, settings, etc.)
--- @param entity LuaEntity: The entity to restore state to
--- @param entity_data table: Serialized entity data
function Deserializer.restore_entity_state(entity, entity_data)
  if not entity.valid or not entity_data.specific_data then
    return
  end

  local data = entity_data.specific_data

  -- Restore ghost-specific properties
  if entity.type == "entity-ghost" or entity.type == "tile-ghost" then
    -- Item requests for ghosts (construction materials needed)
    if data.item_requests and #data.item_requests > 0 then
      local requests = {}
      for _, req in ipairs(data.item_requests) do
        local item_with_quality = {
          name = req.item,
          quality = req.quality
        }
        requests[item_with_quality] = req.count
      end
      -- Note: item_requests is read-only, it's set during ghost creation
      -- This is captured here for documentation but may not be settable
    end
    return  -- Ghosts don't have other state to restore
  end

  -- Restore item-request-proxy properties
  if entity.type == "item-request-proxy" then
    -- Item requests
    if data.item_requests and #data.item_requests > 0 then
      local requests = {}
      for _, req in ipairs(data.item_requests) do
        local item_with_quality = {
          name = req.item,
          quality = req.quality
        }
        requests[item_with_quality] = req.count
      end
      -- Note: item_requests is read-only for proxies as well
    end
    
    -- Insert plan (inventory positions)
    if data.insert_plan then
      entity.insert_plan = data.insert_plan
    end
    
    return  -- Proxies don't have other state to restore
  end

  -- Restore recipe (skip if already set during create_entity for fluid port alignment)
  -- We check if recipe is already set to avoid overwriting and potentially breaking direction
  if data.recipe and entity.set_recipe then
    local current_recipe = entity.get_recipe and entity.get_recipe()
    local current_recipe_name = current_recipe and current_recipe.name
    if current_recipe_name ~= data.recipe then
      safe_call(string.format("set_recipe %s for %s", data.recipe, entity.name),
        function() entity.set_recipe(data.recipe) end)
    end
  end

  -- Restore previous recipe (furnaces/foundries)
  if data.previous_recipe and entity.previous_recipe ~= nil then
    safe_call(string.format("previous_recipe for %s", entity.name), function()
      entity.previous_recipe = {
        name = data.previous_recipe.name,
        quality = data.previous_recipe.quality or "normal"
      }
    end)
  end

  -- Restore crafting progress
  if data.crafting_progress and entity.crafting_progress ~= nil then
    entity.crafting_progress = data.crafting_progress
  end

  -- Restore productivity bonus (read-only in Factorio 2.0+, skip if it fails)
  if data.productivity_bonus and entity.productivity_bonus ~= nil then
    safe_call(string.format("productivity_bonus for %s", entity.name),
      function() entity.productivity_bonus = data.productivity_bonus end)
  end

  -- Restore train schedule
  if data.schedule and entity.train then
    entity.train.schedule = data.schedule
  end

  -- Restore combinator settings
  if data.parameters then
    local cb = entity.get_control_behavior()
    if cb then
      safe_call(string.format("combinator parameters for %s", entity.name),
        function() cb.parameters = data.parameters end)
    end
  end

  -- Restore combinator player description
  if data.player_description and entity.entity_label ~= nil then
    safe_call(string.format("entity_label for %s", entity.name),
      function() entity.entity_label = data.player_description end)
  end

  -- Restore turret priority targets using set_priority_target(index, entity_id)
  -- Note: priority_targets property is read-only, use set_priority_target method
  if data.priority_targets and #data.priority_targets > 0 then
    for _, target in ipairs(data.priority_targets) do
      safe_call(string.format("set_priority_target %d=%s for %s", target.index, target.name, entity.name),
        function() entity.set_priority_target(target.index, target.name) end)
    end
  end
  
  -- Restore ignore_unprioritised_targets (RW boolean on turrets)
  if data.ignore_unprioritised_targets ~= nil then
    safe_call(string.format("ignore_unprioritised_targets for %s", entity.name),
      function() entity.ignore_unprioritised_targets = data.ignore_unprioritised_targets end)
  end
  
  -- The turret control behavior settings (set_priority_list, set_ignore_unlisted_targets, etc.)
  -- are handled in restore_control_behavior()

  -- Restore inserter settings  
  if data.use_filters ~= nil and entity.use_filters ~= nil then
    entity.use_filters = data.use_filters
  end

  if data.filter_mode and entity.inserter_filter_mode ~= nil then
    entity.inserter_filter_mode = data.filter_mode
  end

  if data.stack_size_override and entity.inserter_stack_size_override ~= nil then
    entity.inserter_stack_size_override = data.stack_size_override
  end

  -- Restore splitter filter
  if data.filter and entity.splitter_filter ~= nil then
    entity.splitter_filter = data.filter
  end

  -- Restore splitter priority settings
  if data.input_priority and entity.splitter_input_priority ~= nil then
    safe_call(string.format("splitter_input_priority for %s", entity.name),
      function() entity.splitter_input_priority = data.input_priority end)
  end

  if data.output_priority and entity.splitter_output_priority ~= nil then
    safe_call(string.format("splitter_output_priority for %s", entity.name),
      function() entity.splitter_output_priority = data.output_priority end)
  end

  -- Restore container bar (inventory limit)
  if data.bar and entity.get_inventory then
    local inv = entity.get_inventory(defines.inventory.chest)
    if inv and inv.valid then
      safe_call(string.format("inventory bar for %s", entity.name),
        function() inv.set_bar(data.bar) end)
    end
  end

  -- Restore lamp settings
  if data.color and entity.color ~= nil then
    safe_call(string.format("color for %s", entity.name),
      function() entity.color = data.color end)
  end

  if data.always_on ~= nil and entity.always_on ~= nil then
    safe_call(string.format("always_on for %s", entity.name),
      function() entity.always_on = data.always_on end)
  end

  -- Restore rocket silo auto-launch
  if data.auto_launch ~= nil and entity.auto_launch ~= nil then
    entity.auto_launch = data.auto_launch
  end

  -- Restore rocket parts
  if data.rocket_parts and entity.rocket_parts ~= nil then
    entity.rocket_parts = data.rocket_parts
  end

  -- Restore recipe quality (assemblers, rocket silos)
  if data.recipe_quality and entity.recipe_quality ~= nil then
    safe_call(string.format("recipe_quality for %s", entity.name),
      function() entity.recipe_quality = data.recipe_quality end)
  end

  -- Restore power switch state
  if data.switch_state ~= nil and entity.switch_state ~= nil then
    safe_call(string.format("switch_state for %s", entity.name),
      function() entity.switch_state = data.switch_state end)
  end

  -- Restore pump fluid filter
  if data.fluid_filter and entity.set_fluid_filter then
    safe_call(string.format("fluid_filter for %s", entity.name),
      function() entity.set_fluid_filter(data.fluid_filter) end)
  end

  -- Restore mining drill filter
  if data.filter and entity.mining_target ~= nil then
    safe_call(string.format("mining_target for %s", entity.name),
      function() entity.mining_target = {name = data.filter} end)
  end

  -- Restore artillery auto-targeting
  if data.artillery_auto_targeting ~= nil and entity.artillery_auto_targeting ~= nil then
    safe_call(string.format("artillery_auto_targeting for %s", entity.name),
      function() entity.artillery_auto_targeting = data.artillery_auto_targeting end)
  end

  -- Restore gate open state
  if data.opened ~= nil and entity.opened ~= nil then
    entity.opened = data.opened
  end

  -- Restore agricultural tower planting position (Space Age)
  if data.planting_position and entity.planting_position ~= nil then
    entity.planting_position = data.planting_position
  end

  -- Restore train station custom name and settings
  if entity.type == "train-stop" then
    if entity_data.backer_name then
      entity.backer_name = entity_data.backer_name
    end
    
    if data.manual_trains_limit and entity.trains_limit ~= nil then
      safe_call(string.format("trains_limit for %s", entity.name),
        function() entity.trains_limit = data.manual_trains_limit end)
    end
    
    if data.priority and entity.priority ~= nil then
      safe_call(string.format("train-stop priority for %s", entity.name),
        function() entity.priority = data.priority end)
    end
    
    if data.color and entity.color ~= nil then
      safe_call(string.format("train-stop color for %s", entity.name),
        function() entity.color = data.color end)
    end
  end

  -- Restore entity tags (custom mod data)
  if entity_data.tags then
    entity.tags = entity_data.tags
  end

  -- Restore equipment grid for entities (vehicles, locomotives, etc.)
  if data.equipment_grid and entity.grid and entity.grid.valid then
    Deserializer.restore_equipment_grid(entity.grid, data.equipment_grid)
  end

  -- Restore spidertron autopilot destination
  if data.autopilot_destination and entity.autopilot_destination ~= nil then
    entity.autopilot_destination = data.autopilot_destination
  end

  -- Restore rolling stock and vehicle settings
  if entity.train then
    -- Train/wagon color
    if data.color and entity.color ~= nil then
      safe_call(string.format("train color for %s", entity.name),
        function() entity.color = data.color end)
    end
    
    -- Train logistics
    if data.enable_logistics_while_moving ~= nil and entity.enable_logistics_while_moving ~= nil then
      safe_call(string.format("enable_logistics_while_moving for %s", entity.name),
        function() entity.enable_logistics_while_moving = data.enable_logistics_while_moving end)
    end
    
    -- Copy color from train stop
    if data.copy_color_from_train_stop ~= nil and entity.copy_color_from_train_stop ~= nil then
      safe_call(string.format("copy_color_from_train_stop for %s", entity.name),
        function() entity.copy_color_from_train_stop = data.copy_color_from_train_stop end)
    end
  end

  -- Restore vehicle settings (cars, tanks, spidertrons)
  if entity.type == "car" or entity.type == "spider-vehicle" then
    -- Vehicle color
    if data.color and entity.color ~= nil then
      safe_call(string.format("vehicle color for %s", entity.name),
        function() entity.color = data.color end)
    end
    
    -- Vehicle orientation
    if data.orientation and entity.orientation ~= nil then
      safe_call(string.format("vehicle orientation for %s", entity.name),
        function() entity.orientation = data.orientation end)
    end
    
    -- Driver as main gunner
    if data.driver_is_main_gunner ~= nil and entity.driver_is_main_gunner ~= nil then
      safe_call(string.format("driver_is_main_gunner for %s", entity.name),
        function() entity.driver_is_main_gunner = data.driver_is_main_gunner end)
    end
    
    -- Selected gun index
    if data.selected_gun_index and entity.selected_gun_index ~= nil then
      safe_call(string.format("selected_gun_index for %s", entity.name),
        function() entity.selected_gun_index = data.selected_gun_index end)
    end
    
    -- Vehicle logistics
    if data.enable_logistics_while_moving ~= nil and entity.enable_logistics_while_moving ~= nil then
      safe_call(string.format("vehicle logistics for %s", entity.name),
        function() entity.enable_logistics_while_moving = data.enable_logistics_while_moving end)
    end
    
    -- Spidertron label
    if data.label and entity.type == "spider-vehicle" then
      safe_call(string.format("spidertron label for %s", entity.name),
        function() entity.entity_label = data.label end)
    end
    
    -- Automatic targeting parameters
    if data.automatic_targeting_parameters and entity.enable_logistics_while_moving ~= nil then
      safe_call(string.format("auto targeting for %s", entity.name), function()
        if data.automatic_targeting_parameters.auto_target_with_gunner ~= nil then
          entity.auto_target_with_gunner = data.automatic_targeting_parameters.auto_target_with_gunner
        end
        if data.automatic_targeting_parameters.auto_target_without_gunner ~= nil then
          entity.auto_target_without_gunner = data.automatic_targeting_parameters.auto_target_without_gunner
        end
      end)
    end
  end
end

--- Restore inventories to an entity
--- @param entity LuaEntity: The entity to restore inventories to
--- @param entity_data table: Serialized entity data
function Deserializer.restore_inventories(entity, entity_data)
  if not entity.valid or not entity_data.specific_data then
    return
  end
  
  -- Check if there's anything to restore (inventories only - belt items handled in post-processing)
  local has_inventories = entity_data.specific_data.inventories ~= nil
  
  if not has_inventories then
    return
  end

  -- Restore regular inventories
  if has_inventories then
  for _, inv_data in ipairs(entity_data.specific_data.inventories) do
    -- Convert inventory type name (string) to numeric index
    -- inv_data.type is a string like "crafter_input", need to convert to defines.inventory index
    local inv_index = defines.inventory[inv_data.type]
    if not inv_index then
      log(string.format("[FactorioSurfaceExport] Warning: Unknown inventory type '%s' for entity %s", inv_data.type, entity.name))
      goto continue
    end
    
    local inventory = entity.get_inventory(inv_index)

    if inventory then
      inventory.clear()

      for _, item in ipairs(inv_data.items) do
        -- Check if this is a blueprint/book that needs import_stack()
        if item.export_string then
          -- Use import_stack for blueprint-like items
          local slot_index = nil
          for i = 1, #inventory do
            if not inventory[i].valid_for_read then
              slot_index = i
              break
            end
          end
          
          if slot_index then
            local stack = inventory[slot_index]
            local import_result = stack.import_stack(item.export_string)
            -- import_result: 0 = ok, 1 = ok with errors, -1 = failed
            if import_result < 0 then
              log(string.format("[FactorioSurfaceExport] Warning: Failed to import blueprint for %s", entity.name))
            end
          end
        else
          -- Per-slot restoration using set_stack() to preserve overloaded stacks
          -- (inserters can push items beyond normal stack_size into crafting machines)
          local stack_params = {
            name = item.name,
            count = item.count
          }
          if item.quality and item.quality ~= "normal" then
            stack_params.quality = item.quality
          end

          local ok, err
          if item.slot and item.slot <= #inventory then
            -- Preferred: set_stack on the exact slot (preserves overloaded counts)
            ok, err = pcall(function()
              inventory[item.slot].set_stack(stack_params)
            end)
          else
            -- Fallback: bulk insert (for old export data without slot index)
            ok, err = pcall(function()
              return inventory.insert(stack_params)
            end)
          end

          if not ok then
            log(string.format("[FactorioSurfaceExport] Warning: Skipped unknown item '%s' for %s (mod missing?): %s",
              item.name, entity.name, tostring(err)))
          elseif item.slot and item.slot <= #inventory then
            -- Verify set_stack worked
            local slot = inventory[item.slot]
            if not slot.valid_for_read or slot.count < item.count then
              log(string.format("[FactorioSurfaceExport] Warning: set_stack partial for slot %d: %d/%d of %s into %s",
                item.slot, slot.valid_for_read and slot.count or 0, item.count, item.name, entity.name))
            end
          else
            local inserted = err  -- err is actually the return value from insert()
            if type(inserted) == "number" and inserted < item.count then
              log(string.format("[FactorioSurfaceExport] Warning: Only inserted %d/%d of %s into %s",
                inserted, item.count, item.name, entity.name))
            end

            -- Find the inserted stack to restore additional properties
            if inserted > 0 then
              local inserted_stack = inventory.find_item_stack(item.name)
              if inserted_stack and inserted_stack.valid_for_read then
                -- Restore health
                if item.health and inserted_stack.health then
                  inserted_stack.health = item.health
                end
                
                -- Restore durability
                if item.durability and inserted_stack.durability then
                  inserted_stack.durability = item.durability
                end
                
                -- Restore ammo count
                if item.ammo and inserted_stack.ammo then
                  inserted_stack.ammo = item.ammo
                end
                
                -- Restore spoilage (Space Age)
                if item.spoil_percent and inserted_stack.spoil_percent then
                  inserted_stack.spoil_percent = item.spoil_percent
                end
                
                -- Restore label
                if item.label and inserted_stack.is_item_with_label then
                  inserted_stack.label = item.label.text
                  if item.label.color then
                    inserted_stack.label_color = item.label.color
                  end
                  if item.label.allow_manual_change ~= nil then
                    inserted_stack.allow_manual_label_change = item.label.allow_manual_change
                  end
                end
                
                -- Restore custom description
                if item.custom_description and inserted_stack.custom_description then
                  inserted_stack.custom_description = item.custom_description
                end

                -- Restore equipment grid if present
                if item.grid and inserted_stack.grid then
                  Deserializer.restore_equipment_grid(inserted_stack.grid, item.grid)
                end
                
                -- Restore nested inventory if present
                if item.nested_inventory and inserted_stack.is_item_with_inventory then
                  local sub_inventory = inserted_stack.get_inventory(defines.inventory.item_main)
                  if sub_inventory and sub_inventory.valid then
                    Deserializer.restore_nested_inventory(sub_inventory, item.nested_inventory)
                  end
                end
              end
            end
          end
        end
      end
    end
    ::continue::
  end
  end -- end of if has_inventories

  -- NOTE: Belt items are NOT restored here!
  -- Belt items are restored synchronously in post-processing phase (BeltRestoration.restore)
  -- This is CRITICAL because belts are always active and cannot be deactivated.
  -- Items must be restored all at once to prevent partial restoration where
  -- some items get picked up by inserters before others are placed.

  -- Restore inserter held item
  if entity_data.specific_data.held_item and entity.held_stack then
    local held = entity_data.specific_data.held_item
    local ok, err = pcall(function()
      entity.held_stack.set_stack(held)
    end)
    if not ok then
      log(string.format("[FactorioSurfaceExport] Warning: Failed to restore held item '%s' x%d for %s: %s",
        held.name or "?", held.count or 0, entity.name, tostring(err)))
    elseif not entity.held_stack.valid_for_read then
      log(string.format("[FactorioSurfaceExport] Warning: held_stack.set_stack succeeded but stack empty for %s (item=%s x%d)",
        entity.name, held.name or "?", held.count or 0))
    end
  end

  -- Restore inserter filter mode
  if entity_data.specific_data.filter_mode and entity.inserter_filter_mode ~= nil then
    safe_call(string.format("inserter_filter_mode for %s", entity.name),
      function() entity.inserter_filter_mode = entity_data.specific_data.filter_mode end)
  end

  -- Restore inserter stack size override
  if entity_data.specific_data.stack_size_override and entity.inserter_stack_size_override ~= nil then
    safe_call(string.format("inserter_stack_size_override for %s", entity.name),
      function() entity.inserter_stack_size_override = entity_data.specific_data.stack_size_override end)
  end

  -- Restore inserter spoil priority
  if entity_data.specific_data.spoil_priority and entity.inserter_spoil_priority ~= nil then
    safe_call(string.format("inserter_spoil_priority for %s", entity.name),
      function() entity.inserter_spoil_priority = entity_data.specific_data.spoil_priority end)
  end
end

--- Restore equipment grid (for power armor, etc.)
--- @param grid LuaEquipmentGrid: The grid to restore to
--- @param grid_data table: Serialized grid data
function Deserializer.restore_equipment_grid(grid, grid_data)
  if not grid or not grid.valid then
    return
  end

  grid.clear()

  -- Handle both old format (array) and new format (table with equipment array)
  local equipment_list = grid_data.equipment or grid_data
  
  for _, equip_data in ipairs(equipment_list) do
    local equipment = grid.put({
      name = equip_data.name,
      position = equip_data.position
    })

    if equipment then
      -- Restore energy
      if equip_data.energy and equipment.energy ~= nil then
        equipment.energy = equip_data.energy
      end
      
      -- Restore shield
      if equip_data.shield and equipment.shield ~= nil then
        equipment.shield = equip_data.shield
      end
      
      -- Restore burner equipment fuel state
      if equip_data.burner and equipment.burner then
        local burner = equipment.burner
        
        -- Restore currently burning fuel
        if equip_data.burner.currently_burning then
          burner.currently_burning = equip_data.burner.currently_burning
        end
        
        -- Restore remaining fuel
        if equip_data.burner.remaining_burning_fuel then
          burner.remaining_burning_fuel = equip_data.burner.remaining_burning_fuel
        end
        
        -- Restore burner inventory
        if equip_data.burner.inventory and burner.inventory and burner.inventory.valid then
          Deserializer.restore_nested_inventory(burner.inventory, equip_data.burner.inventory)
        end
        
        -- Restore burnt result inventory
        if equip_data.burner.burnt_result_inventory and burner.burnt_result_inventory and burner.burnt_result_inventory.valid then
          Deserializer.restore_nested_inventory(burner.burnt_result_inventory, equip_data.burner.burnt_result_inventory)
        end
      end
    end
  end
end

--- Restore nested inventory (recursive for items-with-inventory)
--- @param inventory LuaInventory: The inventory to restore to
--- @param items_data table: Array of item data
function Deserializer.restore_nested_inventory(inventory, items_data)
  if not inventory or not inventory.valid or not items_data then
    return
  end

  inventory.clear()

  for _, item in ipairs(items_data) do
    -- Check if this is a blueprint/book that needs import_stack()
    if item.export_string then
      -- Use import_stack for blueprint-like items
      local slot_index = nil
      for i = 1, #inventory do
        if not inventory[i].valid_for_read then
          slot_index = i
          break
        end
      end
      
      if slot_index then
        local stack = inventory[slot_index]
        local import_result = stack.import_stack(item.export_string)
        if import_result < 0 then
          log(string.format("[FactorioSurfaceExport] Warning: Failed to import nested blueprint '%s'", item.name))
        end
      end
    else
      -- Regular item insertion
      local insert_params = {
        name = item.name,
        count = item.count
      }

      if item.quality and item.quality ~= "normal" then
        insert_params.quality = item.quality
      end

      local ok, result = pcall(function()
        return inventory.insert(insert_params)
      end)

      if ok and result > 0 then
        -- Find the inserted stack to restore additional properties
        local inserted_stack = inventory.find_item_stack(item.name)
        if inserted_stack and inserted_stack.valid_for_read then
          -- Restore health
          if item.health and inserted_stack.health then
            inserted_stack.health = item.health
          end
          
          -- Restore durability
          if item.durability and inserted_stack.durability then
            inserted_stack.durability = item.durability
          end
          
          -- Restore ammo count
          if item.ammo and inserted_stack.ammo then
            inserted_stack.ammo = item.ammo
          end
          
          -- Restore spoilage (Space Age)
          if item.spoil_percent and inserted_stack.spoil_percent then
            inserted_stack.spoil_percent = item.spoil_percent
          end
          
          -- Restore label
          if item.label and inserted_stack.is_item_with_label then
            inserted_stack.label = item.label.text
            if item.label.color then
              inserted_stack.label_color = item.label.color
            end
            if item.label.allow_manual_change ~= nil then
              inserted_stack.allow_manual_label_change = item.label.allow_manual_change
            end
          end
          
          -- Restore custom description
          if item.custom_description and inserted_stack.custom_description then
            inserted_stack.custom_description = item.custom_description
          end

          -- Restore equipment grid
          if item.grid and inserted_stack.grid then
            Deserializer.restore_equipment_grid(inserted_stack.grid, item.grid)
          end
          
          -- Recursive: Restore nested inventory
          if item.nested_inventory and inserted_stack.is_item_with_inventory then
            local sub_inventory = inserted_stack.get_inventory(defines.inventory.item_main)
            if sub_inventory and sub_inventory.valid then
              Deserializer.restore_nested_inventory(sub_inventory, item.nested_inventory)
            end
          end
        end
      end
    end
  end
end

--- Restore fluids to an entity
--- @param entity LuaEntity: The entity to restore fluids to
--- @param entity_data table: Serialized entity data
function Deserializer.restore_fluids(entity, entity_data)
  if not entity.valid then
    return
  end
  
  if not entity_data.specific_data then
    -- Debug: Log entities without specific_data
    if entity.type == "thruster" or entity.type == "fusion-reactor" or entity.type == "fusion-generator" then
      log(string.format("[Fluid Restore] Entity %s (%s) has no specific_data", entity.name, entity.type))
    end
    return
  end
  
  if not entity_data.specific_data.fluids then
    -- Debug: Log entities with specific_data but no fluids
    if entity.type == "thruster" or entity.type == "fusion-reactor" or entity.type == "fusion-generator" then
      log(string.format("[Fluid Restore] Entity %s (%s) has specific_data but no fluids", entity.name, entity.type))
    end
    return
  end

  local fluidbox = entity.fluidbox
  if not fluidbox then
    log(string.format("[Fluid Restore] Entity %s (%s) has no fluidbox", entity.name, entity.type))
    return
  end

  -- Restore fluids to fluidbox
  -- CRITICAL: In Factorio 2.0, fluid networks are "segments" with instant distribution.
  -- Using direct fluidbox[i] assignment redistributes fluid across the entire network.
  -- Instead, we use insert_fluid() which ADDS to the network total.
  -- We also need to handle the case where the fluidbox already has a different fluid.
  local restored = 0
  for i, fluid_data in ipairs(entity_data.specific_data.fluids) do
    if i <= #fluidbox then
      -- Debug: Log before state
      local before = fluidbox[i]
      local before_amount = before and before.amount or 0
      local before_name = before and before.name or "none"
      
      -- If there's a different fluid in this slot, we need to clear it first
      if before and before.name ~= fluid_data.name then
        -- Clear by setting to empty (will redistribute existing fluid elsewhere)
        fluidbox[i] = nil
        before_amount = 0
      end
      
      -- Calculate how much fluid we need to ADD to reach the target
      -- Note: The fluidbox might already have some fluid from network redistribution
      local current = fluidbox[i]
      local current_amount = current and current.amount or 0
      local needed = fluid_data.amount - current_amount
      
      if needed > 0 then
        -- Use insert_fluid to ADD fluid to the network
        -- This is better than direct assignment because it adds to network total
        local inserted = entity.insert_fluid({
          name = fluid_data.name,
          amount = needed,
          temperature = fluid_data.temperature
        })
        
        -- Verify the result
        local after = fluidbox[i]
        local after_amount = after and after.amount or 0
        
        if entity.type == "storage-tank" or entity.type == "thruster" then
          log(string.format("[Fluid Restore DEBUG] %s fluidbox[%d]: insert_fluid %.1f (needed %.1f), before=%.1f, after=%.1f (%s @ %.1fC)", 
            entity.type, i, inserted, needed, current_amount, after_amount, fluid_data.name, fluid_data.temperature))
        end
      else
        if entity.type == "storage-tank" or entity.type == "thruster" then
          log(string.format("[Fluid Restore DEBUG] %s fluidbox[%d]: already has %.1f >= target %.1f (%s)", 
            entity.type, i, current_amount, fluid_data.amount, fluid_data.name))
        end
      end
      
      restored = restored + 1
    end
  end
  
  -- Debug: Log thruster/fusion fluid restoration
  if (entity.type == "thruster" or entity.type == "fusion-reactor" or entity.type == "fusion-generator") and restored > 0 then
    log(string.format("[Fluid Restore] Restored %d fluid slots to %s (%s)", 
      restored, entity.name, entity.type))
  end
end

--- Create items on ground
--- @param surface LuaSurface: Target surface
--- @param item_data table: Serialized item data
function Deserializer.create_ground_item(surface, item_data)
  surface.create_entity({
    name = "item-on-ground",
    position = item_data.position,
    stack = {
      name = item_data.name,
      count = item_data.count,
      quality = item_data.quality
    }
  })
end

--- Place tiles on a surface
--- For space platforms, foundation tiles MUST be placed before other tiles
--- @param surface LuaSurface: The surface to place tiles on
--- @param tiles table: Array of tile data
--- @return number, number: placed_count, failed_count
function Deserializer.place_tiles(surface, tiles)
  if not surface or not surface.valid or not tiles then
    return 0, 0
  end

  -- Sort tiles: foundation tiles first, then others
  -- Platform foundations must exist before entities can be placed
  local foundation_tiles = {}
  local other_tiles = {}
  
  for _, tile_data in ipairs(tiles) do
    if tile_data.name == "space-platform-foundation" then
      table.insert(foundation_tiles, {
        name = tile_data.name,
        position = tile_data.position
      })
    else
      table.insert(other_tiles, {
        name = tile_data.name,
        position = tile_data.position
      })
    end
  end

  local placed_count = 0
  local failed_count = 0

  -- Place foundation tiles first
  if #foundation_tiles > 0 then
    local ok, err = pcall(function()
      surface.set_tiles(foundation_tiles, true, false, true, false)
    end)
    if ok then
      placed_count = placed_count + #foundation_tiles
    else
      log(string.format("[FactorioSurfaceExport] Foundation tile placement failed: %s", tostring(err)))
      failed_count = failed_count + #foundation_tiles
    end
  end

  -- Then place other tiles
  if #other_tiles > 0 then
    local ok, err = pcall(function()
      surface.set_tiles(other_tiles, true, false, true, false)
    end)
    if ok then
      placed_count = placed_count + #other_tiles
    else
      log(string.format("[FactorioSurfaceExport] Other tile placement failed: %s", tostring(err)))
      failed_count = failed_count + #other_tiles
    end
  end

  return placed_count, failed_count
end

--- Restore control behavior settings to an entity
--- @param entity LuaEntity: The entity to restore to
--- @param entity_data table: Serialized entity data
function Deserializer.restore_control_behavior(entity, entity_data)
  if not entity.valid or not entity_data.control_behavior then
    return
  end

  local cb = entity.get_control_behavior()
  if not cb then
    return
  end

  local cb_data = entity_data.control_behavior

  -- Helper function to safely set properties with logging
  local function safe_set(prop, value)
    if value ~= nil then
      local ok, err = pcall(function() cb[prop] = value end)
      if not ok then
        log(string.format("[Deserializer Error] cb.%s for %s: %s", prop, entity.name, tostring(err)))
      end
    end
  end

  -- Restore circuit conditions
  safe_set("circuit_condition", cb_data.circuit_condition)
  safe_set("logistic_condition", cb_data.logistic_condition)
  safe_set("enabled_condition", cb_data.enabled_condition)

  -- Restore connection settings
  safe_set("connect_to_logistic_network", cb_data.connect_to_logistic_network)

  -- Restore read settings
  safe_set("read_contents", cb_data.read_contents)
  safe_set("read_stopped_train", cb_data.read_stopped_train)
  safe_set("read_from_train", cb_data.read_from_train)
  safe_set("send_to_train", cb_data.send_to_train)
  safe_set("circuit_read_hand_contents", cb_data.circuit_read_hand_contents)
  safe_set("circuit_hand_read_mode", cb_data.circuit_hand_read_mode)
  safe_set("circuit_mode_of_operation", cb_data.circuit_mode_of_operation)
  safe_set("circuit_read_signal", cb_data.circuit_read_signal)
  safe_set("circuit_set_signal", cb_data.circuit_set_signal)
  safe_set("read_logistics", cb_data.read_logistics)
  safe_set("read_robot_stats", cb_data.read_robot_stats)

  -- Entity-specific settings
  safe_set("circuit_stack_size", cb_data.circuit_stack_size)
  safe_set("use_colors", cb_data.use_colors)
  safe_set("trains_limit", cb_data.trains_limit)
  safe_set("set_trains_limit", cb_data.set_trains_limit)
  safe_set("read_trains_count", cb_data.read_trains_count)
  safe_set("circuit_enable_disable", cb_data.circuit_enable_disable)
  safe_set("circuit_read_resources", cb_data.circuit_read_resources)

  -- Combinator parameters
  safe_set("parameters", cb_data.parameters)

  -- Constant combinator sections (Factorio 2.0+)
  if cb_data.constant_sections then
    -- Clear existing sections
    local clear_ok, clear_err = pcall(function()
      while #cb.sections > 0 do
        cb.remove_section(1)
      end
    end)
    if not clear_ok then
      log(string.format("[Deserializer Error] clear combinator sections for %s: %s", entity.name, tostring(clear_err)))
    end
    
    -- Add new sections with filters
    for sec_idx, section_data in ipairs(cb_data.constant_sections) do
      local success, section = pcall(function()
        return cb.add_section(section_data.group)
      end)
      
      if not success then
        log(string.format("[Deserializer Error] add_section %d for %s: %s", sec_idx, entity.name, tostring(section)))
      elseif section then
        -- Set filters/signals in this section
        for _, filter in ipairs(section_data.filters) do
          local slot_ok, slot_err = pcall(function()
            section.set_slot(filter.index, {
              value = filter.value,
              min = filter.min,
              max = filter.max,
              quality = filter.quality
            })
          end)
          if not slot_ok then
            log(string.format("[Deserializer Error] set_slot %d for %s: %s", filter.index, entity.name, tostring(slot_err)))
          end
        end
      end
    end
  end

  -- Legacy constant combinator signals (pre-2.0, kept for backwards compatibility)
  if cb_data.constant_signals then
    for _, signal_data in ipairs(cb_data.constant_signals) do
      local sig_ok, sig_err = pcall(function()
        cb.set_signal(signal_data.index, {
          signal = signal_data.signal,
          count = signal_data.count
        })
      end)
      if not sig_ok then
        log(string.format("[Deserializer Error] set_signal %d for %s: %s", signal_data.index, entity.name, tostring(sig_err)))
      end
    end
  end

  -- Selector combinator (2.0+)
  safe_set("operation", cb_data.operation)
  safe_set("count", cb_data.count)
  safe_set("quality", cb_data.quality)

  -- Speaker parameters
  safe_set("parameters", cb_data.speaker_parameters)
  safe_set("circuit_parameters", cb_data.circuit_parameters)
  
  -- Turret control behavior (from specific_data if present)
  if entity_data.specific_data then
    local turret_data = entity_data.specific_data
    safe_set("set_ignore_unlisted_targets", turret_data.set_ignore_unlisted_targets)
    safe_set("ignore_unlisted_targets_condition", turret_data.ignore_unlisted_targets_condition)
    safe_set("set_priority_list", turret_data.set_priority_list)
    safe_set("read_ammo", turret_data.read_ammo)
  end
end

--- Restore logistic requests to a requester/buffer chest
--- @param entity LuaEntity: The entity to restore to
--- @param entity_data table: Serialized entity data
function Deserializer.restore_logistic_requests(entity, entity_data)
  if not entity.valid or not entity_data.logistic_requests then
    return
  end

  if entity.type ~= "logistic-container" then
    return
  end

  -- Clear existing requests first
  local clear_ok, clear_err = pcall(function()
    for i = 1, entity.request_slot_count do
      entity.clear_request_slot(i)
    end
  end)
  if not clear_ok then
    log(string.format("[Deserializer Error] clear logistic requests for %s: %s", entity.name, tostring(clear_err)))
  end

  -- Set new requests
  for _, request in ipairs(entity_data.logistic_requests) do
    local req_ok, req_err = pcall(function()
      entity.set_request_slot({
        name = request.name,
        count = request.count,
        quality = request.quality or "normal"
      }, request.index)
    end)
    if not req_ok then
      log(string.format("[Deserializer Error] set_request_slot %s for %s: %s", request.name, entity.name, tostring(req_err)))
    end
  end
end

--- Restore entity filters (filter inserters, loaders, cargo wagons)
--- @param entity LuaEntity: The entity to restore to
--- @param entity_data table: Serialized entity data
function Deserializer.restore_entity_filters(entity, entity_data)
  if not entity.valid or not entity_data.entity_filters then
    return
  end

  -- Filter inserters
  if entity.type == "inserter" then
    -- Check if use_filters is enabled (even if no filters are set yet)
    local has_use_filters = entity_data.specific_data and entity_data.specific_data.use_filters
    
    -- CRITICAL: Enable filter mode if use_filters is true OR if filters exist
    if (has_use_filters or #entity_data.entity_filters > 0) and entity.inserter_filter_mode ~= nil then
      -- If filter_mode wasn't captured, default to whitelist
      local filter_mode = entity_data.specific_data and entity_data.specific_data.filter_mode or "whitelist"
      local mode_success, mode_err = pcall(function()
        entity.inserter_filter_mode = filter_mode
      end)
      if not mode_success then
        log(string.format("[Deserializer] Failed to set inserter filter_mode: %s", tostring(mode_err)))
        return
      end
    end
    
    -- Now set the actual filters
    for _, filter in ipairs(entity_data.entity_filters) do
      local success, err = pcall(function()
        entity.set_filter(filter.index, {
          name = filter.name,
          quality = filter.quality or "normal",
          comparator = filter.comparator
        })
      end)
      if not success then
        log(string.format("[Deserializer] Failed to set inserter filter at index %d: %s", filter.index, tostring(err)))
      end
    end
  end

  -- Loaders
  if entity.type == "loader" or entity.type == "loader-1x1" then
    for _, filter in ipairs(entity_data.entity_filters) do
      local filt_ok, filt_err = pcall(function()
        entity.set_filter(filter.index, {
          name = filter.name,
          quality = filter.quality or "normal"
        })
      end)
      if not filt_ok then
        log(string.format("[Deserializer Error] loader set_filter %d for %s: %s", filter.index, entity.name, tostring(filt_err)))
      end
    end
  end

  -- Cargo wagon filters
  if entity.type == "cargo-wagon" then
    local inventory = entity.get_inventory(defines.inventory.cargo_wagon)
    if inventory and inventory.valid then
      for _, filter in ipairs(entity_data.entity_filters) do
        local filt_ok, filt_err = pcall(function()
          inventory.set_filter(filter.index, {
            name = filter.name,
            quality = filter.quality or "normal"
          })
        end)
        if not filt_ok then
          log(string.format("[Deserializer Error] cargo wagon filter %d for %s: %s", filter.index, entity.name, tostring(filt_err)))
        end
      end
    end
  end

  -- Infinity container filters
  if entity_data.infinity_filters then
    local inf_ok, inf_err = pcall(function()
      entity.infinity_container_filters = entity_data.infinity_filters
    end)
    if not inf_ok then
      log(string.format("[Deserializer Error] infinity_container_filters for %s: %s", entity.name, tostring(inf_err)))
    end
  end
end

--- Restore circuit connections (red/green wires)
--- CRITICAL: Must be called AFTER all entities are created
--- Updated for Factorio 2.0 wire connector API
--- @param entity LuaEntity: The source entity
--- @param entity_data table: Serialized entity data
--- @param entity_map table: Map of entity_id to LuaEntity
function Deserializer.restore_circuit_connections(entity, entity_data, entity_map)
  if not entity.valid then
    return
  end
  
  if not entity_data.circuit_connections then
    return
  end

  -- DEBUG: Log circuit connection data
  log(string.format("[DEBUG] Restoring %d circuit connections for %s (id=%s)",
    #entity_data.circuit_connections,
    entity.name,
    tostring(entity_data.entity_id)))

  for _, conn in ipairs(entity_data.circuit_connections) do
    -- Look up target entity by ID
    local target = entity_map[conn.target_entity_id]
    
    -- DEBUG: Log connection attempt
    log(string.format("[DEBUG] Connection: wire=%s, source_id=%s, target_entity_id=%s, target_circuit_id=%s, target_found=%s",
      tostring(conn.wire),
      tostring(conn.source_circuit_id),
      tostring(conn.target_entity_id),
      tostring(conn.target_circuit_id),
      tostring(target and target.valid)))
    
    -- Fallback: Try position-based lookup if entity_id not found
    if not target and type(conn.target_entity_id) == "string" and conn.target_entity_id:find("^pos_") then
      -- Parse position from "pos_X.XX_Y.YY" format
      local x, y = conn.target_entity_id:match("pos_([%d%.%-]+)_([%d%.%-]+)")
      if x and y then
        x, y = tonumber(x), tonumber(y)
        -- Find entity at that position
        for _, candidate in pairs(entity_map) do
          if candidate.valid then
            local pos = candidate.position
            if math.abs(pos.x - x) < 0.1 and math.abs(pos.y - y) < 0.1 then
              target = candidate
              break
            end
          end
        end
      end
    end

    if target and target.valid then
      -- Factorio 2.0: Use get_wire_connector() and connect_to()
      local success, err = pcall(function()
        local source_connector = entity.get_wire_connector(conn.source_circuit_id, true)
        local target_connector = target.get_wire_connector(conn.target_circuit_id, true)
        
        -- Debug: Log connector details
        log(string.format("[DEBUG] Source connector: type=%s, valid=%s, wire_type=%s",
          type(source_connector),
          tostring(source_connector and source_connector.valid),
          tostring(source_connector and source_connector.wire_type)))
        log(string.format("[DEBUG] Target connector: type=%s, valid=%s, wire_type=%s",
          type(target_connector),
          tostring(target_connector and target_connector.valid),
          tostring(target_connector and target_connector.wire_type)))
          
        if source_connector and target_connector then
          -- Pass false for reach_check since we're scripting connections that may be "out of reach"
          -- CRITICAL: Use DOT syntax, not colon syntax! connect_to() doesn't use implicit self
          local connected = source_connector.connect_to(target_connector, false)
          log(string.format("[DEBUG] Connected %s:%d to %s:%d result=%s",
            entity.name, conn.source_circuit_id, target.name, conn.target_circuit_id, tostring(connected)))
        else
          log(string.format("[WARN] Could not get connectors: source=%s, target=%s",
            tostring(source_connector), tostring(target_connector)))
        end
      end)
      if not success then
        log(string.format("[WARN] Failed to connect wire: %s", tostring(err)))
      end
    else
      log(string.format("[FactorioSurfaceExport] Warning: Could not find target entity %s for circuit connection from %s",
        tostring(conn.target_entity_id), entity.name))
    end
  end
end

--- Restore power connections (copper cables between electric poles)
--- CRITICAL: Must be called AFTER all entities are created
--- @param entity LuaEntity: The source pole
--- @param entity_data table: Serialized entity data
--- @param entity_map table: Map of entity_id to LuaEntity
function Deserializer.restore_power_connections(entity, entity_data, entity_map)
  if not entity.valid or not entity_data.power_connections then
    return
  end

  if entity.type ~= "electric-pole" then
    return
  end

  for _, target_id in ipairs(entity_data.power_connections) do
    -- Look up target entity by ID
    local target = entity_map[target_id]
    
    -- Fallback: Position-based lookup
    if not target and type(target_id) == "string" and target_id:find("^pos_") then
      local x, y = target_id:match("pos_([%d%.%-]+)_([%d%.%-]+)")
      if x and y then
        x, y = tonumber(x), tonumber(y)
        for _, candidate in pairs(entity_map) do
          if candidate.valid and candidate.type == "electric-pole" then
            local pos = candidate.position
            if math.abs(pos.x - x) < 0.1 and math.abs(pos.y - y) < 0.1 then
              target = candidate
              break
            end
          end
        end
      end
    end

    if target and target.valid then
      pcall(function()
        entity.connect_neighbour(target)
      end)
    else
      log(string.format("[FactorioSurfaceExport] Warning: Could not find target pole %s for power connection from %s",
        tostring(target_id), entity.name))
    end
  end
end

return Deserializer

