-- FactorioSurfaceExport - Deserializer
-- Import/restore platform state from JSON

local Util = require("modules/surface_export/utils/util")

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

--- Restore COUNT-NEUTRAL scalar item metadata (health, durability, ammo, spoil_percent, label,
--- custom_description). None of these change an item count, so they are safe to apply on the set_stack
--- (slotted) restore path without perturbing the exact gate census. Grid / nested-inventory restoration
--- (which ADD items) is deliberately kept out of here and lives only in restore_item_properties below.
--- @param stack LuaItemStack: The stack to restore properties on
--- @param item_data table: Serialized item data with optional property fields
local function restore_item_scalar_properties(stack, item_data)
  if not stack or not stack.valid_for_read then return end

  if item_data.health and stack.health then
    stack.health = item_data.health
  end
  if item_data.durability and stack.durability then
    stack.durability = item_data.durability
  end
  if item_data.ammo and stack.ammo then
    stack.ammo = item_data.ammo
  end
  if item_data.spoil_percent and stack.spoil_percent then
    stack.spoil_percent = item_data.spoil_percent
  end
  if item_data.label and stack.is_item_with_label then
    stack.label = item_data.label.text
    if item_data.label.color then
      stack.label_color = item_data.label.color
    end
    if item_data.label.allow_manual_change ~= nil then
      stack.allow_manual_label_change = item_data.label.allow_manual_change
    end
  end
  if item_data.custom_description and stack.custom_description then
    stack.custom_description = item_data.custom_description
  end
end

--- Restore additional properties on a placed item stack
--- (health, durability, ammo, spoil_percent, label, custom_description, grid, nested_inventory)
--- @param stack LuaItemStack: The stack to restore properties on
--- @param item_data table: Serialized item data with optional property fields
local function restore_item_properties(stack, item_data)
  if not stack or not stack.valid_for_read then return end

  restore_item_scalar_properties(stack, item_data)

  if item_data.grid and stack.grid then
    Deserializer.restore_equipment_grid(stack.grid, item_data.grid)
  end
  if item_data.nested_inventory and stack.is_item_with_inventory then
    local sub_inventory = stack.get_inventory(defines.inventory.item_main)
    if sub_inventory and sub_inventory.valid then
      Deserializer.restore_nested_inventory(sub_inventory, item_data.nested_inventory)
    end
  end
end

--- Trivial single-field restore rules for restore_entity_state, transcribed 1:1 from the explicit
--- `if data.<field> ... then entity.<prop> = data.<field> end` blocks they replaced. Each rule
--- restores `entity[prop] = data[field]` when the field is present and the entity supports it.
--- This mirrors the export-side EntityHandlers table: a new exported field gets restored by adding
--- one row here. Non-trivial restorations (recipe, filters, priority targets, equipment grids, the
--- train-stop/train/vehicle sub-blocks) deliberately stay inline in restore_entity_state.
---   field   : key in specific_data (and the entity property, unless `prop` overrides it)
---   prop    : entity property to assign (defaults to `field`)
---   present : guard is `data[field] ~= nil` (booleans, where `false` is a valid value);
---             otherwise the guard is truthy `data[field]` (tables/strings/numbers)
---   safecall: wrap the assignment in safe_call (matches the original block); default is direct
---   no_entity_guard : skip the `entity[prop] ~= nil` support check (only the read-only turret
---                     `ignore_unprioritised_targets` did this — its assignment is safe_call-wrapped)
local SIMPLE_RESTORE_RULES = {
  { field = "crafting_progress" },
  { field = "productivity_bonus", safecall = true },
  -- bonus_progress is RW at 2.0.77 (LuaEntity.bonus_progress); safecall-wrapped like the other
  -- crafter progress fields since not every entity that reaches here exposes it.
  { field = "bonus_progress", safecall = true },
  { field = "player_description", prop = "entity_label", safecall = true },
  { field = "ignore_unprioritised_targets", present = true, safecall = true, no_entity_guard = true },
  { field = "use_filters", present = true },
  { field = "filter_mode", prop = "inserter_filter_mode" },
  { field = "stack_size_override", prop = "inserter_stack_size_override" },
  -- Splitter filter: current exports carry {name,quality}; legacy bare-name exports remain
  -- assignable through the same property restore.
  { field = "filter", prop = "splitter_filter" },
  { field = "input_priority", prop = "splitter_input_priority", safecall = true },
  { field = "output_priority", prop = "splitter_output_priority", safecall = true },
  { field = "color", safecall = true },
  { field = "always_on", present = true, safecall = true },
  { field = "auto_launch", present = true },
  { field = "rocket_parts" },
  -- (recipe_quality was removed: LuaEntity.recipe_quality does not exist at 2.0.77 — the row ALWAYS
  -- threw into its safecall and quality silently reset to normal. Quality now rides set_recipe(name, q)
  -- atomically at both restore sites; measured in the state-dimensions-lab notebook.)
  { field = "switch_state", present = true, safecall = true },
  { field = "artillery_auto_targeting", present = true, safecall = true },
  { field = "opened", present = true },
  { field = "planting_position" },
  { field = "autopilot_destination" },
}

--- Apply SIMPLE_RESTORE_RULES to an entity. Each rule's guards are reproduced exactly so this is a
--- behavior-preserving replacement for the inline blocks.
--- @param entity LuaEntity
--- @param data table: entity_data.specific_data
local function apply_simple_restore_rules(entity, data)
  for _, rule in ipairs(SIMPLE_RESTORE_RULES) do
    local value = data[rule.field]
    local has_value
    if rule.present then
      has_value = value ~= nil          -- booleans: false is a value worth restoring
    else
      has_value = value and true or false -- truthy (these fields are never boolean)
    end
    local prop = rule.prop or rule.field
    if has_value and (rule.no_entity_guard or entity[prop] ~= nil) then
      if rule.safecall then
        safe_call(string.format("%s for %s", prop, entity.name),
          function() entity[prop] = value end)
      else
        entity[prop] = value
      end
    end
  end
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
    -- Quality is passed ATOMICALLY here: set_recipe(name) without it defaults the pair to normal, and
    -- there is no post-hoc fix-up — LuaEntity.recipe_quality does not exist at 2.0.77 (measured; the old
    -- SIMPLE_RESTORE_RULES row for it always threw into its safecall). nil quality = normal, correct for
    -- exports that captured no quality.
    local recipe_success = safe_call(
      string.format("set_recipe %s for %s", entity_data.specific_data.recipe, entity.name),
      function() entity.set_recipe(entity_data.specific_data.recipe, entity_data.specific_data.recipe_quality) end
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
  -- We check if the (name, quality) PAIR is already set to avoid overwriting and potentially breaking
  -- direction. Quality is get_recipe()'s second return and must be passed atomically to set_recipe —
  -- see the create-time site above (LuaEntity.recipe_quality does not exist at 2.0.77).
  if data.recipe and entity.set_recipe then
    local current_recipe, current_quality
    if entity.get_recipe then
      current_recipe, current_quality = entity.get_recipe()
    end
    local current_recipe_name = current_recipe and current_recipe.name
    local current_quality_name = (current_quality and current_quality.name) or Util.QUALITY_NORMAL
    local wanted_quality_name = data.recipe_quality or Util.QUALITY_NORMAL
    if current_recipe_name ~= data.recipe or current_quality_name ~= wanted_quality_name then
      safe_call(string.format("set_recipe %s (quality %s) for %s", data.recipe, wanted_quality_name, entity.name),
        function() entity.set_recipe(data.recipe, data.recipe_quality) end)
    end
  end

  -- Restore previous recipe (furnaces/foundries)
  if data.previous_recipe and entity.previous_recipe ~= nil then
    safe_call(string.format("previous_recipe for %s", entity.name), function()
      entity.previous_recipe = {
        name = data.previous_recipe.name,
        quality = data.previous_recipe.quality or Util.QUALITY_NORMAL
      }
    end)
  end

  -- Trivial single-field restorations (see SIMPLE_RESTORE_RULES). Placed after recipe restoration so
  -- recipe-dependent fields (crafting_progress, bonus_progress) apply to the already-set recipe.
  apply_simple_restore_rules(entity, data)

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

  -- Restore turret priority targets using set_priority_target(index, entity_id)
  -- Note: priority_targets property is read-only, use set_priority_target method
  if data.priority_targets and #data.priority_targets > 0 then
    for _, target in ipairs(data.priority_targets) do
      safe_call(string.format("set_priority_target %d=%s for %s", target.index, target.name, entity.name),
        function() entity.set_priority_target(target.index, target.name) end)
    end
  end
  
  -- The turret control behavior settings (set_priority_list, set_ignore_unlisted_targets, etc.)
  -- are handled in restore_control_behavior(). ignore_unprioritised_targets, the inserter
  -- use_filters/filter_mode/stack_size_override settings, and the splitter filter/priorities are
  -- restored by apply_simple_restore_rules above (SIMPLE_RESTORE_RULES).

  -- Restore container bar (inventory limit)
  if data.bar and entity.get_inventory then
    local inv = entity.get_inventory(defines.inventory.chest)
    if inv and inv.valid then
      safe_call(string.format("inventory bar for %s", entity.name),
        function() inv.set_bar(data.bar) end)
    end
  end

  -- Restore pump fluid filter
  if data.fluid_filter and entity.set_fluid_filter then
    safe_call(string.format("fluid_filter for %s", entity.name),
      function() entity.set_fluid_filter(data.fluid_filter) end)
  end

  -- Restore mining drill resource filter.
  -- Current exports carry {name,quality}; legacy exports used a bare item name.
  if data.filter and entity.set_filter then
    local filter_value = data.filter
    if type(data.filter) == "table" then
      filter_value = {
        name = data.filter.name,
        quality = data.filter.quality or Util.QUALITY_NORMAL
      }
    end
    safe_call(string.format("set_filter for %s", entity.name),
      -- Keep the engine call isolated: the pending live signature probe adjusts only this line.
      function() entity.set_filter(1, filter_value) end)
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

  -- Restore burner (fuel) energy-source state. Set currently_burning FIRST: writing
  -- remaining_burning_fuel silently no-ops when there is no currently_burning item (2.0.77 LuaBurner).
  -- Resolve the serialized item name to a prototype so an unknown mod item is skipped (not crashed).
  -- currently_burning is burn-progress, NOT an inventory slot, so neither the expected-count
  -- (Verification.count_all_items) nor the dest census (SurfaceCounter.count_items) reads it directly.
  -- VERIFIED [empirical, 2.0.77] by the closer run (tests/state-dimensions-lab/NOTEBOOK.md + the passing
  -- entity-burner-roundtrip; api-notes): (a) the write is ACCEPTED while the entity is DEACTIVATED — a deactivated
  -- burner reads back currently_burning/remaining_burning_fuel exactly; (b) setting currently_burning does
  -- NOT mutate the fuel inventory, and this running before restore_inventories' clear()+refill leaves the
  -- burn state undisturbed. No relocation to the activation pass needed.
  if data.burner and entity.burner then
    local burner_data = data.burner
    local burning = burner_data.currently_burning
    if burning and burning.name then
      if prototypes.item[burning.name] then
        safe_call(string.format("burner currently_burning for %s", entity.name), function()
          entity.burner.currently_burning = {
            name = burning.name,
            quality = burning.quality or Util.QUALITY_NORMAL
          }
        end)
      else
        log(string.format("[Deserializer] Skipped burner currently_burning '%s' for %s (unknown item, mod missing?)",
          tostring(burning.name), entity.name))
      end
    end
    if burner_data.remaining_burning_fuel then
      safe_call(string.format("burner remaining_burning_fuel for %s", entity.name),
        function() entity.burner.remaining_burning_fuel = burner_data.remaining_burning_fuel end)
    end
  end

  -- Restore entity energy buffer (accumulator charge, machine energy store).
  -- VERIFIED [empirical, 2.0.77] by the closer run (state-dimensions-lab NOTEBOOK + passing
  -- energy-roundtrip; api-notes): a write to `.energy` is ACCEPTED while the entity is DEACTIVATED (accumulator
  -- 0->123456 read back exactly; machine buffer written in-range read back exactly). Energy is not
  -- item-counted, so it does not perturb the exact gate census. No relocation to the activation pass.
  if data.energy ~= nil then
    safe_call(string.format("energy for %s", entity.name),
      function() entity.energy = data.energy end)
  end

  -- Restore entity heat buffer temperature (reactors, heat pipes, heat-consumers).
  -- VERIFIED [empirical, 2.0.77] by the closer run (state-dimensions-lab NOTEBOOK + passing heat-roundtrip; api-notes):
  -- a write to `.temperature` is ACCEPTED while the entity is DEACTIVATED (reactor 15->500 read back
  -- exactly). Not item-counted; no gate perturbation; no relocation to the activation pass.
  if data.temperature ~= nil then
    safe_call(string.format("temperature for %s", entity.name),
      function() entity.temperature = data.temperature end)
  end
end

--- Restore inventories to an entity
--- @param entity LuaEntity: The entity to restore inventories to
--- @param entity_data table: Serialized entity data
--- @param overflow_losses table|nil: Optional { items={name->count}, total=n, entities={...} } to accumulate set_stack partial losses into
function Deserializer.restore_inventories(entity, entity_data, overflow_losses)
  if not entity.valid or not entity_data.specific_data then
    return
  end
  
  -- Check if there's anything to restore (inventories only - belt items handled in post-processing)
  local has_inventories = entity_data.specific_data.inventories ~= nil

  if not has_inventories then
    return
  end

  -- Restore regular inventories
  -- CRITICAL: crafter_modules MUST be restored before crafter_input/output.
  -- The engine computes input slot caps as: recipe_amount × module_multiplier.
  -- If input items are set_stack()'d before modules are placed, the cap reflects
  -- no-module state, causing partial writes ("wanted 12, placed 7").
  -- Sort so crafter_modules comes first; all other inventories follow unchanged.
  if has_inventories then
  local sorted_inventories = {}
  for _, inv_data in ipairs(entity_data.specific_data.inventories) do
    if inv_data.type == "crafter_modules" then
      table.insert(sorted_inventories, 1, inv_data)
    else
      table.insert(sorted_inventories, inv_data)
    end
  end
  for _, inv_data in ipairs(sorted_inventories) do
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
          if item.quality and item.quality ~= Util.QUALITY_NORMAL then
            stack_params.quality = item.quality
          end

          local ok, err
          if item.slot and item.slot <= #inventory then
            -- Preferred: set_stack on the exact slot (preserves overloaded counts)
            ok, err = pcall(function()
              inventory[item.slot].set_stack(stack_params)
            end)
            -- DIAG: log beacon module set_stack result
            if entity.name == "beacon" then
              local slot = inventory[item.slot]
              log(string.format("[DiagBeacon] set_stack slot=%d item=%s q=%s ok=%s err=%s valid=%s count=%s",
                item.slot, item.name, tostring(item.quality), tostring(ok), tostring(err),
                tostring(slot.valid_for_read), tostring(slot.valid_for_read and slot.count or "n/a")))
            end
            -- DIAG END
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
            -- Restore FULL item metadata on the slotted stack. The set_stack path historically skipped
            -- restore_item_properties entirely (only the no-slot insert fallback ran it), silently dropping
            -- spoilage decay, health, durability, ammo, labels — AND equipment grids / nested inventories
            -- (a slotted power armor arrived with an EMPTY grid; review finding at deserializer.lua:642).
            -- EMPIRICAL (2.0.77, spoilage-roundtrip): bioflux spoil_percent 0.5003 -> 0 pre-fix.
            -- Gate-neutrality of grid/nested restoration VERIFIED against both gate counters: the expected
            -- side (Verification.count_all_items, verification.lua) sums only top-level
            -- specific_data.inventories[].items[].count, and the dest census (SurfaceCounter.count_items ->
            -- InventoryScanner.count_all_items) sums only top-level inv.items[].count — NEITHER recurses
            -- into item.grid or item.nested_inventory, so restoring them cannot move either side of the
            -- exact gate. Covered by tests/integration/item-grid-roundtrip (physical dest grid reads).
            if slot.valid_for_read then
              restore_item_properties(slot, item)
            end
            if not slot.valid_for_read or slot.count < item.count then
              local actual_count = slot.valid_for_read and slot.count or 0
              local lost = item.count - actual_count
              log(string.format("[FactorioSurfaceExport] Warning: set_stack partial for slot %d: %d/%d of %s into %s",
                item.slot, actual_count, item.count, item.name, entity.name))
              if overflow_losses and lost > 0 then
                local item_key = Util.make_quality_key(item.name, item.quality or Util.QUALITY_NORMAL)
                overflow_losses.items[item_key] = (overflow_losses.items[item_key] or 0) + lost
                overflow_losses.total = overflow_losses.total + lost
                -- Record per-entity detail (capped at 50)
                if #overflow_losses.entities < 50 then
                  table.insert(overflow_losses.entities, {
                    name = entity.name,
                    position = entity.position,
                    item = item.name,
                    quality = item.quality or Util.QUALITY_NORMAL,
                    lost = lost,
                    actual = actual_count,
                    expected = item.count,
                  })
                end
              end
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
              restore_item_properties(inserted_stack, item)
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
    -- quality must be passed AT put() time — grid equipment quality is not writable afterwards, so
    -- omitting it silently downgraded every restored piece to normal (review finding, deserializer.lua:741).
    local equipment = grid.put({
      name = equip_data.name,
      position = equip_data.position,
      quality = equip_data.quality
    })

    if equipment then
      -- Restore energy / shield. EMPIRICAL (2.0.77, equipment-burner-roundtrip crash at tick 138282,
      -- this file's restore_equipment_grid): LuaEquipment.shield (and .energy) READS 0 on equipment
      -- that has no shield/energy buffer, so the old `equipment.X ~= nil` guard is a FALSE guard (a
      -- read never returns nil) and export captures a truthy 0; the WRITE then throws "Equipment is not
      -- shields" and killed the import on_tick. safe_call each write (it logs) so an unsupported buffer
      -- is skipped, not fatal. Presence check stays: only attempt when a value was captured.
      if equip_data.energy then
        safe_call(string.format("equipment energy for %s", tostring(equip_data.name)),
          function() equipment.energy = equip_data.energy end)
      end

      if equip_data.shield then
        safe_call(string.format("equipment shield for %s", tostring(equip_data.name)),
          function() equipment.shield = equip_data.shield end)
      end
      
      -- Restore burner equipment fuel state. Mirrors the entity-burner restore pattern (see
      -- restore_entity_state): prototype-existence check so an unknown mod fuel item is SKIPPED (not
      -- crashed — restore_equipment_grid runs unwrapped inside the import on_tick, the tick-138282 crash
      -- class), safe_call on every engine write, and quality carried through. Accepts both the current
      -- {name, quality} capture shape and the legacy bare-string shape from older exports.
      if equip_data.burner and equipment.burner then
        local burner = equipment.burner

        local eq_burning = equip_data.burner.currently_burning
        if eq_burning then
          local fuel_name = type(eq_burning) == "table" and eq_burning.name or eq_burning
          local fuel_quality = (type(eq_burning) == "table" and eq_burning.quality) or Util.QUALITY_NORMAL
          if fuel_name and prototypes.item[fuel_name] then
            safe_call(string.format("equipment burner currently_burning for %s", tostring(equip_data.name)),
              function() burner.currently_burning = { name = fuel_name, quality = fuel_quality } end)
          elseif fuel_name then
            log(string.format("[Deserializer] Skipped equipment burner currently_burning '%s' for %s (unknown item, mod missing?)",
              tostring(fuel_name), tostring(equip_data.name)))
          end
        end

        if equip_data.burner.remaining_burning_fuel then
          safe_call(string.format("equipment burner remaining_burning_fuel for %s", tostring(equip_data.name)),
            function() burner.remaining_burning_fuel = equip_data.burner.remaining_burning_fuel end)
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

      if item.quality and item.quality ~= Util.QUALITY_NORMAL then
        insert_params.quality = item.quality
      end

      local ok, result = pcall(function()
        return inventory.insert(insert_params)
      end)

      if not ok then
        log(string.format("[Deserializer] Failed to insert nested item '%s' x%d: %s",
          item.name or "?", item.count or 0, tostring(result)))
      end
      if ok and result > 0 then
        local inserted_stack = inventory.find_item_stack(item.name)
        restore_item_properties(inserted_stack, item)
      end
    end
  end
end

--- Create items on ground
--- @param surface LuaSurface: Target surface
--- @param item_data table: Serialized item data
function Deserializer.create_ground_item(surface, item_data)
  local stack = { name = item_data.name, count = item_data.count, quality = item_data.quality }
  local ok, entity = pcall(function()
    return surface.create_entity({ name = "item-on-ground", position = item_data.position, stack = stack })
  end)
  if ok and entity and entity.valid then
    return entity
  end
  -- A pcall ERROR here is a genuine fault (bad stack/signature/unknown item), NOT an expected
  -- collision (create_entity returns nil WITHOUT erroring on collision) — surface it so such a bug
  -- isn't masked as silent ground-item loss. Expected collisions (ok=true, entity=nil) stay quiet.
  if not ok then
    log(string.format("[Deserializer] create_ground_item '%s' x%s errored on first attempt: %s",
      tostring(item_data.name), tostring(item_data.count), tostring(entity)))
  end
  -- Position may now be occupied by a restored building; retry at a nearby non-colliding spot.
  local pos = surface.find_non_colliding_position("item-on-ground", item_data.position, 8, 0.25)
  if pos then
    local ok2, entity2 = pcall(function()
      return surface.create_entity({ name = "item-on-ground", position = pos, stack = stack })
    end)
    if ok2 and entity2 and entity2.valid then
      return entity2
    end
    if not ok2 then
      log(string.format("[Deserializer] create_ground_item '%s' x%s errored on retry: %s",
        tostring(item_data.name), tostring(item_data.count), tostring(entity2)))
    end
  end
  return nil  -- caller (entity_creation.lua) tallies the loss
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

  -- get_or_create (NOT get): an entity may not have instantiated its control behavior yet at restore time
  -- (a lamp has NO control behavior until it is wired, and wires are restored separately), so plain
  -- get_control_behavior() returns nil and every setting below is silently skipped. EMPIRICAL (2.0.77,
  -- circuit-config-roundtrip): an unwired lamp's get_control_behavior()=nil, so its restored
  -- circuit_condition/circuit_enable_disable were dropped. The entity_data.control_behavior guard above
  -- means we only ever create a CB on an entity that HAD one at export, so no spurious CB is created.
  local cb = entity.get_or_create_control_behavior()
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
        quality = request.quality or Util.QUALITY_NORMAL
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
          quality = filter.quality or Util.QUALITY_NORMAL,
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
          quality = filter.quality or Util.QUALITY_NORMAL
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
            quality = filter.quality or Util.QUALITY_NORMAL
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
--- @return number: Count of successful connections made
function Deserializer.restore_circuit_connections(entity, entity_data, entity_map)
  if not entity.valid then
    return 0
  end

  if not entity_data.circuit_connections then
    return 0
  end

  local connected_count = 0

  log(string.format("[Import] Restoring %d circuit connections for %s (id=%s)",
    #entity_data.circuit_connections,
    entity.name,
    tostring(entity_data.entity_id)))

  for _, conn in ipairs(entity_data.circuit_connections) do
    -- Look up target entity by ID
    local target = entity_map[conn.target_entity_id]

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

        if source_connector and target_connector then
          -- Pass false for reach_check since we're scripting connections that may be "out of reach"
          -- CRITICAL: Use DOT syntax, not colon syntax! connect_to() doesn't use implicit self
          local connected = source_connector.connect_to(target_connector, false)
          if connected then
            connected_count = connected_count + 1
          end
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

  return connected_count
end

--- Restore power connections (copper cables between electric poles)
--- CRITICAL: Must be called AFTER all entities are created
--- @param entity LuaEntity: The source pole
--- @param entity_data table: Serialized entity data
--- @param entity_map table: Map of entity_id to LuaEntity
--- @return number: Count of successful connections made
function Deserializer.restore_power_connections(entity, entity_data, entity_map)
  if not entity.valid or not entity_data.power_connections then
    return 0
  end

  if entity.type ~= "electric-pole" then
    return 0
  end

  local connected_count = 0

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
      local ok, result = pcall(function()
        return entity.connect_neighbour(target)
      end)
      if ok and result then
        connected_count = connected_count + 1
      elseif not ok then
        log(string.format("[Deserializer] connect_neighbour failed for pole %s -> %s: %s",
          entity.name, tostring(target_id), tostring(result)))
      end
    else
      log(string.format("[FactorioSurfaceExport] Warning: Could not find target pole %s for power connection from %s",
        tostring(target_id), entity.name))
    end
  end

  return connected_count
end

return Deserializer

