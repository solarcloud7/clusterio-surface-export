-- Remote Interface: test_import_entity
-- Test importing a single entity from JSON for debugging
-- Also re-exports the created entity to verify data was correctly applied

local Deserializer = require("modules/surface_export/core/deserializer")
local EntityScanner = require("modules/surface_export/export_scanners/entity-scanner")
local json = require("modules/surface_export/core/json")

--- Test import a single entity from export JSON
--- @param entity_json string|table: Entity data (JSON string or table)
--- @param surface_index number|nil: Target surface index (nil = player 1's surface)
--- @param position_override table|nil: Override position {x, y}
--- @return table: Result with success, entity, errors, warnings
return function(entity_json, surface_index, position_override)
  local result = {
    success = false,
    entity = nil,
    entity_data = nil,
    errors = {},
    warnings = {},
    debug_info = {}
  }
  
  -- Parse JSON if string
  local entity_data
  if type(entity_json) == "string" then
    local ok, parsed = pcall(json.decode, entity_json)
    if not ok then
      table.insert(result.errors, "Failed to parse JSON: " .. tostring(parsed))
      return result
    end
    entity_data = parsed
  elseif type(entity_json) == "table" then
    entity_data = entity_json
  else
    table.insert(result.errors, "entity_json must be a string or table, got: " .. type(entity_json))
    return result
  end
  
  result.entity_data = entity_data
  
  -- Validate required fields
  if not entity_data.name then
    table.insert(result.errors, "Entity data missing 'name' field")
    return result
  end
  
  -- Position is required unless position_override is provided
  if not entity_data.position and not position_override then
    table.insert(result.errors, "Entity data missing 'position' field (use position_override or include position in JSON)")
    return result
  end
  
  -- Apply position override early so validation uses the correct position
  if position_override then
    entity_data.position = {x = position_override.x, y = position_override.y}
    result.debug_info.position_overridden = true
  end
  
  -- Get target surface
  local surface
  if surface_index then
    surface = game.surfaces[surface_index]
    if not surface then
      table.insert(result.errors, "Surface index " .. surface_index .. " not found")
      return result
    end
  else
    -- Use player 1's current surface as default
    local player = game.get_player(1)
    if player then
      surface = player.surface
    else
      surface = game.surfaces[1]
    end
  end
  
  result.debug_info.surface_name = surface.name
  result.debug_info.surface_index = surface.index
  
  result.debug_info.target_position = entity_data.position
  result.debug_info.entity_name = entity_data.name
  result.debug_info.entity_type = entity_data.type
  
  -- Check if prototype exists
  local prototype = prototypes.entity[entity_data.name]
  if not prototype then
    table.insert(result.errors, "Entity prototype not found: " .. entity_data.name)
    table.insert(result.warnings, "This entity may be from a mod that isn't loaded")
    return result
  end
  
  result.debug_info.prototype_type = prototype.type
  result.debug_info.prototype_flags = {}
  for flag, _ in pairs(prototype.flags or {}) do
    table.insert(result.debug_info.prototype_flags, flag)
  end
  
  -- Get force
  local force = game.forces.player
  
  -- Check if position is clear
  local existing = surface.find_entities_filtered({
    position = entity_data.position,
    radius = 0.5
  })
  if #existing > 0 then
    result.debug_info.existing_entities = {}
    for _, e in ipairs(existing) do
      table.insert(result.debug_info.existing_entities, e.name .. " at " .. serpent.line(e.position))
    end
    table.insert(result.warnings, "Found " .. #existing .. " existing entity(s) near target position")
  end
  
  -- Try to create the entity using the deserializer
  local create_success, created_entity = pcall(function()
    return Deserializer.create_entity(surface, entity_data, force)
  end)
  
  if not create_success then
    table.insert(result.errors, "Deserializer.create_entity threw error: " .. tostring(created_entity))
    return result
  end
  
  if not created_entity then
    table.insert(result.errors, "Deserializer.create_entity returned nil (creation failed)")
    
    -- Try to get more info about why
    local can_place = surface.can_place_entity({
      name = entity_data.name,
      position = entity_data.position,
      direction = entity_data.direction or 0,
      force = force
    })
    result.debug_info.can_place_entity = can_place
    
    if not can_place then
      table.insert(result.warnings, "surface.can_place_entity returned false - position may be blocked or invalid")
    end
    
    return result
  end
  
  -- Success! Gather info about the created entity
  result.success = true
  result.entity = created_entity
  result.debug_info.created_unit_number = created_entity.unit_number
  result.debug_info.created_position = created_entity.position
  result.debug_info.created_direction = created_entity.direction
  
  -- Restore fluids if entity has fluidbox and data has fluids
  if entity_data.specific_data and entity_data.specific_data.fluids then
    local fluid_restore_success, fluid_error = pcall(function()
      Deserializer.restore_fluids(created_entity, entity_data)
    end)
    
    if fluid_restore_success then
      -- Verify fluids were restored
      if created_entity.valid and created_entity.fluidbox then
        result.debug_info.fluids_restored = {}
        for i = 1, #created_entity.fluidbox do
          local fluid = created_entity.fluidbox[i]
          if fluid then
            table.insert(result.debug_info.fluids_restored, {
              slot = i,
              name = fluid.name,
              amount = fluid.amount,
              temperature = fluid.temperature
            })
          end
        end
        
        -- Compare with expected
        local expected_fluids = entity_data.specific_data.fluids
        if expected_fluids and #expected_fluids > 0 then
          local expected_amount = expected_fluids[1].amount
          local actual_amount = 0
          if #result.debug_info.fluids_restored > 0 then
            actual_amount = result.debug_info.fluids_restored[1].amount or 0
          end
          
          if actual_amount < expected_amount * 0.99 then
            table.insert(result.warnings, string.format(
              "Fluid amount mismatch: expected %.1f, got %.1f (%.1f%%)", 
              expected_amount, actual_amount, (actual_amount / expected_amount) * 100
            ))
          end
        end
      end
    else
      table.insert(result.warnings, "Fluid restoration failed: " .. tostring(fluid_error))
    end
  end
  
  -- Restore entity state (items, turret priorities, inserter settings, etc.)
  -- Always call this - it handles many entity-specific properties
  local state_restore_success, state_error = pcall(function()
    Deserializer.restore_entity_state(created_entity, entity_data)
  end)
  
  if not state_restore_success then
    table.insert(result.warnings, "Entity state restoration failed: " .. tostring(state_error))
  end
  
  -- Restore inventories (chest contents, etc. - NOT belt items)
  local inv_restore_success, inv_error = pcall(function()
    Deserializer.restore_inventories(created_entity, entity_data)
  end)
  
  if not inv_restore_success then
    table.insert(result.warnings, "Inventory restoration failed: " .. tostring(inv_error))
  end
  
  -- Restore belt items directly (normally handled by BeltRestoration post-processing phase)
  -- The deserializer skips belt items because in real imports they must all be placed
  -- in a single tick. For single-entity tests we can do it inline.
  if entity_data.specific_data and entity_data.specific_data.items 
     and created_entity.valid and created_entity.get_transport_line then
    local belt_items_placed = 0
    local belt_items_failed = 0
    for _, line_data in ipairs(entity_data.specific_data.items) do
      local line = created_entity.get_transport_line(line_data.line)
      if line and line.valid and line_data.items then
        for _, item in ipairs(line_data.items) do
          local stack = {
            name = item.name,
            count = item.count,
            quality = item.quality or "normal"
          }
          local success = false
          if item.position then
            success = line.insert_at(item.position, stack, item.count)
          end
          if not success then
            success = line.insert_at_back(stack, item.count)
          end
          if success then
            belt_items_placed = belt_items_placed + item.count
          else
            belt_items_failed = belt_items_failed + item.count
          end
        end
      end
    end
    result.debug_info.belt_items_placed = belt_items_placed
    result.debug_info.belt_items_failed = belt_items_failed
    if belt_items_failed > 0 then
      table.insert(result.warnings, string.format(
        "Belt restoration: %d placed, %d failed", belt_items_placed, belt_items_failed))
    end
  end
  -- Note: Turret priority targeting is controlled entirely via circuit network
  -- (LuaTurretControlBehavior), not stored on the entity itself
  
  -- Check if entity has expected properties
  if entity_data.items and created_entity.get_inventory then
    local main_inv = created_entity.get_inventory(defines.inventory.chest)
    if main_inv then
      result.debug_info.inventory_size = #main_inv
    end
  end
  
  if entity_data.recipe and created_entity.get_recipe then
    local recipe = created_entity.get_recipe()
    result.debug_info.recipe_set = recipe and recipe.name or "none"
    if entity_data.recipe ~= (recipe and recipe.name) then
      table.insert(result.warnings, "Recipe mismatch: expected '" .. tostring(entity_data.recipe) .. "', got '" .. tostring(recipe and recipe.name) .. "'")
    end
  end
  
  -- Re-export the created entity to verify data roundtrip
  if created_entity.valid then
    local export_success, exported_data = pcall(function()
      return EntityScanner.serialize_entity(created_entity)
    end)
    
    if export_success and exported_data then
      result.exported_entity = exported_data
      result.comparison = {}
      
      -- Compare specific_data fields
      local input_sd = entity_data.specific_data or {}
      local output_sd = exported_data.specific_data or {}
      
      --- Normalize belt item arrays for comparison.
      --- For each item in the output, only keep fields that exist in the
      --- corresponding input item. This lets the test define what it cares
      --- about (name/count/quality) without failing on output-only fields
      --- like `position` that get_detailed_contents() adds on re-export.
      local function normalize_belt_items(input_lines, output_lines)
        if type(input_lines) ~= "table" or type(output_lines) ~= "table" then
          return input_lines, output_lines
        end
        -- Build a set of keys used in input items
        local input_keys = {}
        for _, line_data in ipairs(input_lines) do
          if line_data.items then
            for _, item in ipairs(line_data.items) do
              for k, _ in pairs(item) do
                input_keys[k] = true
              end
            end
          end
        end
        -- Strip keys from output items that aren't in the input
        local norm_output = {}
        for _, line_data in ipairs(output_lines) do
          local norm_line = { line = line_data.line, items = {} }
          if line_data.items then
            for _, item in ipairs(line_data.items) do
              local norm_item = {}
              for k, v in pairs(item) do
                if input_keys[k] then
                  norm_item[k] = v
                end
              end
              table.insert(norm_line.items, norm_item)
            end
          end
          table.insert(norm_output, norm_line)
        end
        return input_lines, norm_output
      end

      -- Build comparison report
      local function compare_field(field_name)
        local input_val = input_sd[field_name]
        local output_val = output_sd[field_name]
        local input_type = type(input_val)
        local output_type = type(output_val)
        
        if input_val == nil and output_val == nil then
          return nil -- Both missing, no comparison needed
        end
        
        -- If input was nil, we didn't specify this field - skip comparison
        -- The game may have assigned a default value, but that's expected
        if input_val == nil then
          return nil  -- Field not in input, don't compare against default
        end
        
        local input_json, output_json
        local match = false
        if input_type == "table" and output_type == "table" then
          -- For belt items, strip output-only fields before comparing
          local cmp_input = input_val
          local cmp_output = output_val
          if field_name == "items" then
            cmp_input, cmp_output = normalize_belt_items(input_val, output_val)
          end
          -- Deep comparison via JSON encode
          input_json = json.encode(cmp_input)
          output_json = json.encode(cmp_output)
          match = (input_json == output_json)
        else
          match = (input_val == output_val)
          input_json = tostring(input_val)
          output_json = tostring(output_val)
        end
        
        return {
          field = field_name,
          input = input_val,
          output = output_val,
          input_json = input_json,
          output_json = output_json,
          match = match
        }
      end
      
      -- Compare key fields we care about
      -- Turret fields: priority_targets (array), ignore_unprioritised_targets (boolean)
      local fields_to_compare = {
        "fluids", "items",
        "inserter_stack_size_override", "filter_mode",
        "recipe", "recipe_quality",
        "priority_targets", "ignore_unprioritised_targets"
      }
      
      for _, field in ipairs(fields_to_compare) do
        local cmp = compare_field(field)
        if cmp then
          table.insert(result.comparison, cmp)
          if not cmp.match then
            -- Include truncated JSON diff in warning for diagnostics
            local input_str = cmp.input_json or tostring(cmp.input)
            local output_str = cmp.output_json or tostring(cmp.output)
            -- Truncate to keep output manageable
            if #input_str > 300 then input_str = input_str:sub(1, 300) .. "..." end
            if #output_str > 300 then output_str = output_str:sub(1, 300) .. "..." end
            table.insert(result.warnings, string.format(
              "Roundtrip mismatch for '%s': INPUT=%s | OUTPUT=%s",
              field, input_str, output_str
            ))
          end
        end
      end
      
      -- Summary
      local mismatches = 0
      for _, cmp in ipairs(result.comparison) do
        if not cmp.match then
          mismatches = mismatches + 1
        end
      end
      result.comparison_summary = {
        fields_compared = #result.comparison,
        matches = #result.comparison - mismatches,
        mismatches = mismatches
      }
    else
      table.insert(result.warnings, "Re-export failed: " .. tostring(exported_data))
    end
  end
  
  return result
end
