local Util = require("modules/surface_export/utils/util")
local InventoryScanner = require("modules/surface_export/export_scanners/inventory-scanner")

local Deserializer = {}

local function safe_call(context, func)
  local ok, err = pcall(func)
  if not ok then
    log(string.format("[Deserializer Error] %s: %s", context, tostring(err)))
  end
  return ok
end

function Deserializer.new_item_state_session()
  return { applied = 0, declined = 0, failed = 0, logged = 0 }
end

function Deserializer.release_item_state_session(session)
  if session and session.scratch then
    Util.pcall_warn("[Deserializer] item-state scratch release", function()
      InventoryScanner.release_item_state_cache(session.scratch)
    end)
    session.scratch = false
  end
end

local function session_scratch(session)
  if session.scratch == nil then
    local ok, cache = pcall(InventoryScanner.new_item_state_cache)
    session.scratch = ok and cache or false
    if not ok then
      log(string.format("[Deserializer] item-state scratch unavailable (%s) — every export_string is declined; "
        .. "the plain stack is still placed", tostring(cache)))
    end
  end
  return session.scratch or nil
end

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
  if item_data.entity_data and stack.prototype.type == "item-with-entity-data" then
    local values = item_data.entity_data
    safe_call(string.format("item entity-data for %s", stack.name), function()
      if values.entity_color ~= nil then stack.entity_color = values.entity_color end
      if values.entity_enable_logistics_while_moving ~= nil then
        stack.entity_enable_logistics_while_moving = values.entity_enable_logistics_while_moving
      end
      if values.entity_logistics_enabled ~= nil then
        stack.entity_logistics_enabled = values.entity_logistics_enabled
      end
      if values.entity_request_from_buffers ~= nil then
        stack.entity_request_from_buffers = values.entity_request_from_buffers
      end
      if values.entity_logistic_sections ~= nil then
        stack.entity_logistic_sections = values.entity_logistic_sections
      end
    end)
  end
end

local function restore_export_string_with_session(stack, item, session)
  local name = stack.name
  local quality = (stack.quality and stack.quality.name) or Util.QUALITY_NORMAL
  local count = stack.count

  local scratch = session_scratch(session)
  local keeps, seen = false, "no scratch inventory"
  if scratch then
    keeps, seen = InventoryScanner.export_string_keeps_identity(scratch, name, quality, count, item.export_string)
  end
  if not keeps then
    session.declined = session.declined + 1
    restore_item_scalar_properties(stack, item)
    session.logged = session.logged + 1
    if session.logged <= 10 then
      log(string.format("[Deserializer] ITEM STATE DECLINED export_string for %s (%s) x%d: the scratch preflight "
        .. "read %s — the live stack keeps the plain item and its scalar properties, and was not written",
        name, quality, count, tostring(seen)))
    end
    return false
  end

  local ok, result = pcall(function() return stack.import_stack(item.export_string) end)
  if ok and result == 0 then
    session.applied = session.applied + 1
    return true
  end
  session.failed = session.failed + 1
  session.logged = session.logged + 1
  if session.logged <= 10 then
    log(string.format("[Deserializer] ITEM STATE export_string WRITE FAILED for %s: %s", name,
      ok and ("import_stack returned " .. tostring(result)) or tostring(result)))
  end
  return false
end

local function restore_export_string_stack(stack, item, session)
  if not (stack and stack.valid_for_read) then
    log(string.format("[Deserializer] ITEM STATE export_string skipped for '%s': the plain stack did not take, "
      .. "so there is nothing to write the string onto", tostring(item.name)))
    return false
  end
  if session then return restore_export_string_with_session(stack, item, session) end

  local name = stack.name
  local transient = Deserializer.new_item_state_session()
  local ok, applied = pcall(restore_export_string_with_session, stack, item, transient)
  Deserializer.release_item_state_session(transient)
  if not ok then error(applied, 0) end
  if transient.declined + transient.failed > 0 then
    log(string.format("[Deserializer] ITEM STATE for %s on a restore with no session: declined %d failed %d — "
      .. "the guard ran, but these counts reach no import metrics",
      name, transient.declined, transient.failed))
  end
  return applied
end

local function place_plain_stack(stack, item)
  local stack_params = { name = item.name, count = item.count }
  if item.quality and item.quality ~= Util.QUALITY_NORMAL then
    stack_params.quality = item.quality
  end
  return pcall(function() stack.set_stack(stack_params) end)
end

local function restore_item_properties(stack, item_data, item_state)
  if not stack or not stack.valid_for_read then return end

  restore_item_scalar_properties(stack, item_data)

  if item_data.grid and stack.grid then
    Deserializer.restore_equipment_grid(stack.grid, item_data.grid, item_state)
  end
  if item_data.nested_inventory and stack.is_item_with_inventory then
    local sub_inventory = stack.get_inventory(defines.inventory.item_main)
    if sub_inventory and sub_inventory.valid then
      Deserializer.restore_nested_inventory(sub_inventory, item_data.nested_inventory, item_state)
    end
  end
end

Deserializer.restore_item_properties = restore_item_properties

local SIMPLE_RESTORE_RULES = {
  { field = "crafting_progress" },
  { field = "result_quality", safecall = true, types = { ["assembling-machine"] = true } },
  { field = "character_corpse_death_cause", safecall = true, types = { ["character-corpse"] = true } },
  { field = "bonus_progress", safecall = true },
  { field = "player_description", prop = "combinator_description", safecall = true },
  { field = "ignore_unprioritised_targets", present = true, safecall = true, no_entity_guard = true },
  { field = "use_filters", present = true },
  { field = "filter_mode", prop = "inserter_filter_mode" },
  { field = "stack_size_override", prop = "inserter_stack_size_override" },
  { field = "spoil_priority", prop = "inserter_spoil_priority", safecall = true },
  { field = "filter", prop = "splitter_filter", safecall = true,
    types = { ["splitter"] = true, ["lane-splitter"] = true } },
  { field = "pickup_from_left_lane", present = true, safecall = true, types = { ["inserter"] = true } },
  { field = "pickup_from_right_lane", present = true, safecall = true, types = { ["inserter"] = true } },
  { field = "loader_filter_mode", safecall = true, types = { ["loader"] = true, ["loader-1x1"] = true } },
  { field = "loader_belt_stack_size_override", safecall = true,
    types = { ["loader"] = true, ["loader-1x1"] = true } },
  { field = "mining_drill_filter_mode", safecall = true, types = { ["mining-drill"] = true } },
  { field = "storage_filter", safecall = true, types = { ["logistic-container"] = true } },
  { field = "valve_threshold_override", safecall = true, types = { ["valve"] = true } },
  { field = "send_to_orbit_automatically", present = true, safecall = true, types = { ["rocket-silo"] = true } },
  { field = "use_transitional_requests", present = true, safecall = true, types = { ["rocket-silo"] = true } },
  { field = "alert_parameters", safecall = true, types = { ["programmable-speaker"] = true } },
  { field = "linked_belt_type", safecall = true, types = { ["linked-belt"] = true } },
  { field = "link_id", safecall = true, types = { ["linked-container"] = true } },
  { field = "override_logistic_mode", safecall = true, types = { ["infinity-container"] = true } },
  { field = "saved_request_filters", safecall = true, types = { ["infinity-container"] = true } },
  { field = "saved_storage_filters", safecall = true, types = { ["infinity-container"] = true } },
  { field = "saved_request_from_buffers", present = true, safecall = true,
    types = { ["infinity-container"] = true } },
  { field = "saved_set_requests", present = true, safecall = true, types = { ["infinity-container"] = true } },
  { field = "input_priority", prop = "splitter_input_priority", safecall = true },
  { field = "output_priority", prop = "splitter_output_priority", safecall = true },
  { field = "color", safecall = true },
  { field = "always_on", present = true, safecall = true },
  { field = "rocket_parts" },
  { field = "artillery_auto_targeting", present = true, safecall = true },
  { field = "autopilot_destination" },
  { field = "switch_state", prop = "power_switch_state", present = true, safecall = true,
    types = { ["power-switch"] = true } },
  { field = "automatic_targeting_parameters", prop = "vehicle_automatic_targeting_parameters",
    present = true, safecall = true, types = { ["spider-vehicle"] = true } },
}

local function apply_simple_restore_rules(entity, data)
  for _, rule in ipairs(SIMPLE_RESTORE_RULES) do
    local value = data[rule.field]
    local has_value
    if rule.present then
      has_value = value ~= nil
    else
      has_value = value and true or false
    end
    local prop = rule.prop or rule.field
    local applies
    if rule.types then
      applies = rule.types[entity.type] or false
    elseif rule.no_entity_guard then
      applies = true
    else
      -- intentional probe; failure expected on classes where the read throws, no log
      local read_ok, read_val = pcall(function() return entity[prop] end)
      applies = read_ok and read_val ~= nil
    end
    if has_value and applies then
      if rule.safecall then
        safe_call(string.format("%s for %s", prop, entity.name),
          function() entity[prop] = value end)
      else
        entity[prop] = value
      end
    end
  end
end

function Deserializer.create_entity(surface, entity_data)
  if entity_data.name == "space-platform-hub" then
    log("[Deserializer] Skipping space-platform-hub (created automatically with platform)")
    return nil
  end
  
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

  if entity_data.orientation then
    params.orientation = entity_data.orientation
  end

  if entity_data.quality then
    params.quality = entity_data.quality
  end

  if entity_data.type == "underground-belt" and entity_data.specific_data then
    params.type = entity_data.specific_data.belt_to_ground_type
  end

  if (entity_data.type == "loader" or entity_data.type == "loader-1x1")
      and entity_data.specific_data and entity_data.specific_data.loader_type then
    params.type = entity_data.specific_data.loader_type
  end

  if entity_data.type == "resource" and entity_data.specific_data
      and entity_data.specific_data.amount then
    params.amount = entity_data.specific_data.amount
  end

  if entity_data.type == "item-request-proxy" then
    local sd = entity_data.specific_data or {}
    local tp = sd.target_position or entity_data.position
    local tpx, tpy = tp.x or tp[1], tp.y or tp[2]
    local target, fallback
    for _, candidate in ipairs(surface.find_entities_filtered({
      area = { { tpx - 0.3, tpy - 0.3 }, { tpx + 0.3, tpy + 0.3 } } })) do
      if candidate.valid and candidate.unit_number and candidate.type ~= "item-request-proxy" then
        if sd.target_name and candidate.name == sd.target_name then
          target = candidate
          break
        end
        fallback = fallback or candidate
      end
    end
    target = target or (not sd.target_name and fallback) or nil
    if not target and fallback then
      log(string.format("[Deserializer] item-request-proxy target name '%s' not found at (%.1f, %.1f); nearest candidate '%s' NOT used — proxy dropped",
        tostring(sd.target_name), tpx, tpy, fallback.name))
    end
    if not target then
      log(string.format("[Deserializer Error] item-request-proxy at (%.1f, %.1f): no target entity at (%.1f, %.1f) — proxy dropped",
        entity_data.position.x or entity_data.position[1] or 0,
        entity_data.position.y or entity_data.position[2] or 0, tpx, tpy))
      return nil
    end
    params.target = target
    if sd.insert_plan then
      params.modules = sd.insert_plan
    end
  end

  if entity_data.type == "character-corpse" and entity_data.specific_data
      and entity_data.specific_data.corpse_inventory_size then
    params.inventory_size = entity_data.specific_data.corpse_inventory_size
  end

  if entity_data.type == "entity-ghost" and entity_data.specific_data then
    params.inner_name = entity_data.specific_data.ghost_name
    if entity_data.specific_data.ghost_quality then
      params.quality = entity_data.specific_data.ghost_quality
    end
    if entity_data.specific_data.loader_type then
      params.type = entity_data.specific_data.loader_type
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

  if entity.valid and (entity.type == "assembling-machine" or entity.type == "furnace" or entity.type == "rocket-silo")
    and entity_data.specific_data and entity_data.specific_data.recipe then
    local recipe_success = safe_call(
      string.format("set_recipe %s for %s", entity_data.specific_data.recipe, entity.name),
      function() entity.set_recipe(entity_data.specific_data.recipe, entity_data.specific_data.recipe_quality) end
    )
    if recipe_success then
      if entity_data.direction and entity.direction ~= entity_data.direction then
        entity.direction = entity_data.direction
      end
    end
  end

  if (entity_data.type == "assembling-machine" or entity_data.type == "furnace") and entity.valid then
    log(string.format("[DEBUG] Created %s - requested direction=%s, actual direction=%s, recipe=%s",
      entity_data.name,
      tostring(entity_data.direction),
      tostring(entity.direction),
      tostring(entity_data.specific_data and entity_data.specific_data.recipe or "none")))
  end

  if entity_data.mirror then
    safe_call(string.format("mirroring for %s", entity.name),
      function() entity.mirroring = true end)
  end

  if entity_data.health and entity.health then
    entity.health = entity_data.health
  end

  return entity
end

function Deserializer.restore_segmented_unit_state(entity, wanted)
  local unit = entity.segmented_unit
  if not (unit and unit.valid) then
    log(string.format("[Deserializer] segmented_unit activity state DROPPED for %s: no unit on the entity",
      entity.name))
    return false
  end

  if wanted.minimum_activity_mode ~= nil then
    safe_call(string.format("minimum_activity_mode for %s", entity.name),
      function() unit.minimum_activity_mode = wanted.minimum_activity_mode end)
  end

  if wanted.activity_mode ~= nil then
    safe_call(string.format("activity_mode for %s", entity.name),
      function() unit.activity_mode = wanted.activity_mode end)
  end

  return true
end

function Deserializer.restore_entity_state(entity, entity_data)
  if not entity.valid then
    return
  end

  if entity_data.destructible == false then
    local ok, err = pcall(function() entity.destructible = false end)
    if not ok then log("[Deserializer] destructible restore failed for " .. entity.name .. ": " .. tostring(err)) end
  end

  if entity_data.name_tag ~= nil then
    local ok, err = pcall(function() entity.name_tag = entity_data.name_tag end)
    if not ok then log("[Deserializer] name_tag restore failed for " .. entity.name .. ": " .. tostring(err)) end
  end

  if entity_data.custom_status ~= nil then
    local ok, err = pcall(function() entity.custom_status = entity_data.custom_status end)
    if not ok then log("[Deserializer] custom_status restore failed for " .. entity.name .. ": " .. tostring(err)) end
  end

  if type(entity_data.last_user) == "string" then
    local player = game.get_player(entity_data.last_user)
    if player then
      local ok, err = pcall(function() entity.last_user = player end)
      if not ok then log("[Deserializer] last_user restore failed for " .. entity.name .. ": " .. tostring(err)) end
    else
      log(string.format("[Deserializer] last_user '%s' is not a player on this instance — %s left unattributed",
        tostring(entity_data.last_user), entity.name))
    end
  end

  if not entity_data.specific_data then
    return
  end

  local data = entity_data.specific_data

  if entity.type == "entity-ghost" then
    if data.insert_plan and #data.insert_plan > 0 then
      safe_call(string.format("insert_plan for ghost of %s", tostring(data.ghost_name)),
        function() entity.insert_plan = data.insert_plan end)
    end
    return
  end

  if entity.type == "tile-ghost" then
    return
  end

  if entity.type == "display-panel" then
    if data.display_panel_text ~= nil then
      safe_call(string.format("display_panel_text for %s", entity.name),
        function() entity.display_panel_text = data.display_panel_text end)
    end
    if data.display_panel_always_show ~= nil then
      safe_call(string.format("display_panel_always_show for %s", entity.name),
        function() entity.display_panel_always_show = data.display_panel_always_show end)
    end
    if data.display_panel_show_in_chart ~= nil then
      safe_call(string.format("display_panel_show_in_chart for %s", entity.name),
        function() entity.display_panel_show_in_chart = data.display_panel_show_in_chart end)
    end
    if data.display_panel_icon ~= nil then
      safe_call(string.format("display_panel_icon for %s", entity.name),
        function() entity.display_panel_icon = data.display_panel_icon end)
    end
    if data.display_panel_messages then
      safe_call(string.format("display-panel messages for %s", entity.name), function()
        entity.get_or_create_control_behavior().records = data.display_panel_messages
      end)
    end
    return
  end

  if entity.type == "item-request-proxy" then
    if data.insert_plan then
      safe_call(string.format("insert_plan for item-request-proxy targeting %s", tostring(data.target_name)),
        function() entity.insert_plan = data.insert_plan end)
    end

    return
  end

  local IS_CRAFTER = { ["assembling-machine"] = true, ["furnace"] = true, ["rocket-silo"] = true }
  if data.recipe and IS_CRAFTER[entity.type] then
    local current_recipe, current_quality = entity.get_recipe()
    local current_recipe_name = current_recipe and current_recipe.name
    local current_quality_name = (current_quality and current_quality.name) or Util.QUALITY_NORMAL
    local wanted_quality_name = data.recipe_quality or Util.QUALITY_NORMAL
    if current_recipe_name ~= data.recipe or current_quality_name ~= wanted_quality_name then
      safe_call(string.format("set_recipe %s (quality %s) for %s", data.recipe, wanted_quality_name, entity.name),
        function() entity.set_recipe(data.recipe, data.recipe_quality) end)
    end
  end

  if data.grown_ticks_remaining ~= nil then
    safe_call(string.format("plant grow-tick for %s", entity.name),
      function() entity.tick_grown = game.tick + data.grown_ticks_remaining end)
  end

  if data.corpse_death_ticks_ago ~= nil then
    safe_call(string.format("corpse death-tick for %s", entity.name),
      function() entity.character_corpse_tick_of_death = math.max(0, game.tick - data.corpse_death_ticks_ago) end)
  end

  apply_simple_restore_rules(entity, data)

  if entity.type == "inserter" and entity.prototype.allow_custom_vectors then
    if data.pickup_position ~= nil then
      safe_call(string.format("pickup_position for %s", entity.name),
        function() entity.pickup_position = data.pickup_position end)
    end
    if data.drop_position ~= nil then
      safe_call(string.format("drop_position for %s", entity.name),
        function() entity.drop_position = data.drop_position end)
    end
  end

  if entity.type == "linked-belt" and entity_data.direction ~= nil then
    safe_call(string.format("linked-belt direction for %s", entity.name),
      function() entity.direction = entity_data.direction end)
  end

  if data.schedule and entity.train then
    entity.train.schedule = data.schedule
  end

  if data.parameters then
    local cb = entity.get_control_behavior()
    if cb then
      safe_call(string.format("combinator parameters for %s", entity.name),
        function() cb.parameters = data.parameters end)
    end
  end

  if data.priority_targets and #data.priority_targets > 0 then
    for _, target in ipairs(data.priority_targets) do
      safe_call(string.format("set_priority_target %d=%s for %s", target.index, target.name, entity.name),
        function() entity.set_priority_target(target.index, target.name) end)
    end
  end
  

  if data.bar then
    safe_call(string.format("inventory bar for %s", entity.name), function()
      local inv = entity.get_inventory(defines.inventory.chest)
      if inv and inv.valid then
        inv.set_bar(data.bar)
      end
    end)
  end

  if data.fluid_filter then
    safe_call(string.format("fluid_filter for %s", entity.name),
      function() entity.set_fluid_filter(data.fluid_filter) end)
  end

  if data.filter and entity.type == "mining-drill" and (entity.filter_slot_count or 0) > 0 then
    local filter_name = type(data.filter) == "table" and data.filter.name or data.filter
    safe_call(string.format("set_filter for %s", entity.name),
      function() entity.set_filter(1, filter_name) end)
  end

  if entity.type == "train-stop" then
    if entity_data.backer_name then
      entity.backer_name = entity_data.backer_name
    end
    
    if data.manual_trains_limit and entity.trains_limit ~= nil then
      safe_call(string.format("trains_limit for %s", entity.name),
        function() entity.trains_limit = data.manual_trains_limit end)
    end
    
    if data.priority ~= nil then
      safe_call(string.format("train-stop priority for %s", entity.name),
        function() entity.train_stop_priority = data.priority end)
    end
    
    if data.color and entity.color ~= nil then
      safe_call(string.format("train-stop color for %s", entity.name),
        function() entity.color = data.color end)
    end
  end

  if entity_data.tags then
    entity.tags = entity_data.tags
  end

  if data.equipment_grid and entity.grid and entity.grid.valid then
    Deserializer.restore_equipment_grid(entity.grid, data.equipment_grid)
  end

  if entity.train then
    if data.color and entity.color ~= nil then
      safe_call(string.format("train color for %s", entity.name),
        function() entity.color = data.color end)
    end
    
    if data.enable_logistics_while_moving ~= nil and entity.enable_logistics_while_moving ~= nil then
      safe_call(string.format("enable_logistics_while_moving for %s", entity.name),
        function() entity.enable_logistics_while_moving = data.enable_logistics_while_moving end)
    end
    
    if data.copy_color_from_train_stop ~= nil and entity.copy_color_from_train_stop ~= nil then
      safe_call(string.format("copy_color_from_train_stop for %s", entity.name),
        function() entity.copy_color_from_train_stop = data.copy_color_from_train_stop end)
    end
  end

  if entity.type == "space-platform-hub" then
    for _, hub_field in ipairs({
      "providing_to_other_platforms",
      "request_missing_construction_materials",
      "request_from_buffers",
    }) do
      if data[hub_field] ~= nil then
        safe_call(string.format("%s for %s", hub_field, entity.name),
          function() entity[hub_field] = data[hub_field] end)
      end
    end
  end

  if entity.type == "car" or entity.type == "spider-vehicle" then
    if data.color and entity.color ~= nil then
      safe_call(string.format("vehicle color for %s", entity.name),
        function() entity.color = data.color end)
    end
    
    if data.orientation and entity.orientation ~= nil then
      safe_call(string.format("vehicle orientation for %s", entity.name),
        function() entity.orientation = data.orientation end)
    end
    
    if data.driver_is_gunner ~= nil then
      safe_call(string.format("driver_is_gunner for %s", entity.name),
        function() entity.driver_is_gunner = data.driver_is_gunner end)
    end
    
    if data.selected_gun_index and entity.selected_gun_index ~= nil then
      safe_call(string.format("selected_gun_index for %s", entity.name),
        function() entity.selected_gun_index = data.selected_gun_index end)
    end
    
    if data.enable_logistics_while_moving ~= nil and entity.enable_logistics_while_moving ~= nil then
      safe_call(string.format("vehicle logistics for %s", entity.name),
        function() entity.enable_logistics_while_moving = data.enable_logistics_while_moving end)
    end
    
    if data.label and entity.type == "spider-vehicle" then
      safe_call(string.format("spidertron label for %s", entity.name),
        function() entity.entity_label = data.label end)
    end
  end

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

  if data.energy ~= nil then
    safe_call(string.format("energy for %s", entity.name),
      function() entity.energy = data.energy end)
  end

  if data.temperature ~= nil then
    safe_call(string.format("temperature for %s", entity.name),
      function() entity.temperature = data.temperature end)
  end

  if data.segmented_unit then
    Deserializer.restore_segmented_unit_state(entity, data.segmented_unit)
  end
end

function Deserializer.restore_inventories(entity, entity_data, overflow_losses, item_state)
  if not entity.valid or not entity_data.specific_data then
    return
  end
  
  local has_inventories = entity_data.specific_data.inventories ~= nil

  if not has_inventories then
    return
  end

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
    local inv_index = defines.inventory[inv_data.type]
    if not inv_index then
      log(string.format("[FactorioSurfaceExport] Warning: Unknown inventory type '%s' for entity %s", inv_data.type, entity.name))
      goto continue
    end
    
    local inventory = entity.get_inventory(inv_index)

    if inventory then
      inventory.clear()

      for _, item in ipairs(inv_data.items) do
        if item.export_string then
          local slot_index = nil
          if item.slot and item.slot <= #inventory and not inventory[item.slot].valid_for_read then
            slot_index = item.slot
          else
            for i = 1, #inventory do
              if not inventory[i].valid_for_read then
                slot_index = i
                break
              end
            end
          end

          if slot_index then
            local stack = inventory[slot_index]
            local placed_ok, placed_err = place_plain_stack(stack, item)
            if not placed_ok then
              log(string.format("[FactorioSurfaceExport] Warning: Skipped unknown item '%s' for %s (mod missing?): "
                .. "%s — its export_string is dropped with it, and the absent item fails the census",
                item.name, entity.name, tostring(placed_err)))
            else
              restore_export_string_stack(stack, item, item_state)
            end
          else
            log(string.format("[Deserializer] No free slot in %s for '%s' — the item is dropped and the absent "
              .. "item fails the census", entity.name, tostring(item.name)))
          end
        else
          local stack_params = {
            name = item.name,
            count = item.count
          }
          if item.quality and item.quality ~= Util.QUALITY_NORMAL then
            stack_params.quality = item.quality
          end

          local ok, err
          if item.slot and item.slot <= #inventory then
            ok, err = pcall(function()
              inventory[item.slot].set_stack(stack_params)
            end)
            if entity.name == "beacon" then
              local slot = inventory[item.slot]
              log(string.format("[DiagBeacon] set_stack slot=%d item=%s q=%s ok=%s err=%s valid=%s count=%s",
                item.slot, item.name, tostring(item.quality), tostring(ok), tostring(err),
                tostring(slot.valid_for_read), tostring(slot.valid_for_read and slot.count or "n/a")))
            end
          else
            ok, err = pcall(function()
              return inventory.insert(stack_params)
            end)
          end

          if not ok then
            log(string.format("[FactorioSurfaceExport] Warning: Skipped unknown item '%s' for %s (mod missing?): %s",
              item.name, entity.name, tostring(err)))
          elseif item.slot and item.slot <= #inventory then
            local slot = inventory[item.slot]
            if slot.valid_for_read then
              restore_item_properties(slot, item, item_state)
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
            local inserted = err
            if type(inserted) == "number" and inserted < item.count then
              log(string.format("[FactorioSurfaceExport] Warning: Only inserted %d/%d of %s into %s",
                inserted, item.count, item.name, entity.name))
            end

            if inserted > 0 then
              local inserted_stack = inventory.find_item_stack(item.name)
              restore_item_properties(inserted_stack, item, item_state)
            end
          end
        end
      end
    end
    ::continue::
  end
  end


end

function Deserializer.restore_equipment_grid(grid, grid_data, item_state)
  if not grid or not grid.valid then
    return
  end

  grid.clear()

  local equipment_list = grid_data.equipment or grid_data
  
  for _, equip_data in ipairs(equipment_list) do
    local equipment = grid.put({
      name = equip_data.name,
      position = equip_data.position,
      quality = equip_data.quality
    })

    if equipment then
      if equip_data.energy then
        safe_call(string.format("equipment energy for %s", tostring(equip_data.name)),
          function() equipment.energy = equip_data.energy end)
      end

      if equip_data.shield then
        safe_call(string.format("equipment shield for %s", tostring(equip_data.name)),
          function() equipment.shield = equip_data.shield end)
      end
      
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
        
        if equip_data.burner.inventory and burner.inventory and burner.inventory.valid then
          Deserializer.restore_nested_inventory(burner.inventory, equip_data.burner.inventory, item_state)
        end

        if equip_data.burner.burnt_result_inventory and burner.burnt_result_inventory and burner.burnt_result_inventory.valid then
          Deserializer.restore_nested_inventory(burner.burnt_result_inventory, equip_data.burner.burnt_result_inventory, item_state)
        end
      end
    end
  end
end

function Deserializer.restore_nested_inventory(inventory, items_data, item_state)
  if not inventory or not inventory.valid or not items_data then
    return
  end

  inventory.clear()

  for _, item in ipairs(items_data) do
    if item.export_string then
      local slot_index = nil
      for i = 1, #inventory do
        if not inventory[i].valid_for_read then
          slot_index = i
          break
        end
      end

      if slot_index then
        local stack = inventory[slot_index]
        local placed_ok, placed_err = place_plain_stack(stack, item)
        if not placed_ok then
          log(string.format("[Deserializer] Failed to place nested item '%s': %s",
            tostring(item.name), tostring(placed_err)))
        else
          restore_export_string_stack(stack, item, item_state)
        end
      end
    else
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
        restore_item_properties(inserted_stack, item, item_state)
      end
    end
  end
end

function Deserializer.create_ground_item(surface, item_data)
  local stack = { name = item_data.name, count = item_data.count, quality = item_data.quality }
  local ok, entity = pcall(function()
    return surface.create_entity({ name = "item-on-ground", position = item_data.position, stack = stack })
  end)
  if ok and entity and entity.valid then
    return entity
  end
  if not ok then
    log(string.format("[Deserializer] create_ground_item '%s' x%s errored on first attempt: %s",
      tostring(item_data.name), tostring(item_data.count), tostring(entity)))
  end
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
  return nil
end

function Deserializer.place_tiles(surface, tiles)
  if not surface or not surface.valid or not tiles then
    return 0, 0
  end

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

function Deserializer.restore_control_behavior(entity, entity_data)
  if not entity.valid or not entity_data.control_behavior then
    return
  end

  local cb = entity.get_or_create_control_behavior()
  if not cb then
    return
  end

  local cb_data = entity_data.control_behavior

  local function safe_set(prop, value)
    if value ~= nil then
      local ok, err = pcall(function() cb[prop] = value end)
      if not ok then
        log(string.format("[Deserializer Error] cb.%s for %s: %s", prop, entity.name, tostring(err)))
      end
    end
  end

  safe_set("circuit_condition", cb_data.circuit_condition)
  safe_set("logistic_condition", cb_data.logistic_condition)
  safe_set("enabled_condition", cb_data.enabled_condition)

  safe_set("connect_to_logistic_network", cb_data.connect_to_logistic_network)

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

  safe_set("circuit_stack_size", cb_data.circuit_stack_size)
  safe_set("use_colors", cb_data.use_colors)
  safe_set("trains_limit", cb_data.trains_limit)
  safe_set("set_trains_limit", cb_data.set_trains_limit)
  safe_set("read_trains_count", cb_data.read_trains_count)
  safe_set("circuit_enable_disable", cb_data.circuit_enable_disable)
  safe_set("circuit_read_resources", cb_data.circuit_read_resources)

  safe_set("parameters", cb_data.parameters)

  if cb_data.constant_sections then
    local clear_ok, clear_err = pcall(function()
      while #cb.sections > 0 do
        cb.remove_section(1)
      end
    end)
    if not clear_ok then
      log(string.format("[Deserializer Error] clear combinator sections for %s: %s", entity.name, tostring(clear_err)))
    end
    
    for sec_idx, section_data in ipairs(cb_data.constant_sections) do
      local success, section = pcall(function()
        return cb.add_section(section_data.group)
      end)
      
      if not success then
        log(string.format("[Deserializer Error] add_section %d for %s: %s", sec_idx, entity.name, tostring(section)))
      elseif section then
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

  safe_set("operation", cb_data.operation)
  safe_set("count", cb_data.count)
  safe_set("quality", cb_data.quality)

  safe_set("parameters", cb_data.speaker_parameters)
  safe_set("circuit_parameters", cb_data.circuit_parameters)
  
  if entity_data.specific_data then
    local turret_data = entity_data.specific_data
    safe_set("set_ignore_unlisted_targets", turret_data.set_ignore_unlisted_targets)
    safe_set("ignore_unlisted_targets_condition", turret_data.ignore_unlisted_targets_condition)
    safe_set("set_priority_list", turret_data.set_priority_list)
    safe_set("read_ammo", turret_data.read_ammo)
  end
end

function Deserializer.restore_logistic_sections(entity, entity_data)
  local created_groups = {}
  if not entity.valid or entity_data.logistic_sections == nil then
    return created_groups
  end
  if type(entity_data.logistic_sections) ~= "table" then
    log(string.format("[Deserializer Error] logistic_sections on %s is a %s, not a table — field skipped",
      entity.name, type(entity_data.logistic_sections)))
    return created_groups
  end

  local existing_groups = {}
  local registry_ok, registry_err = pcall(function()
    for _, name in pairs(entity.force.get_logistic_groups()) do
      existing_groups[name] = true
    end
  end)
  if not registry_ok then
    log(string.format("[Deserializer Error] get_logistic_groups for %s: %s — grouped sections will be linked but no group filters written",
      entity.name, tostring(registry_err)))
  end

  for _, point_data in ipairs(entity_data.logistic_sections) do
    if type(point_data) ~= "table" or type(point_data.sections) ~= "table" then
      log(string.format("[Deserializer Error] malformed logistic_sections point record on %s (%s) — point skipped",
        entity.name, type(point_data)))
    else
      local pt_ok, point = pcall(function() return entity.get_logistic_point(point_data.point_index) end)
      if not pt_ok or not point then
        log(string.format("[Deserializer Error] logistic point %s missing on %s: %s",
          tostring(point_data.point_index), entity.name, tostring(pt_ok and "nil point" or point)))
      else
        local rm_ok, rm_err = pcall(function()
          for i = point.sections_count, 1, -1 do
            local section = point.sections[i]
            if section and section.is_manual then
              point.remove_section(i)
            end
          end
        end)
        if not rm_ok then
          log(string.format("[Deserializer Error] clearing manual sections on %s: %s", entity.name, tostring(rm_err)))
        end
        local remaining = 0
        local count_ok, count_err = pcall(function()
          for _, section in pairs(point.sections or {}) do
            if section.is_manual then remaining = remaining + 1 end
          end
        end)
        if not count_ok or remaining > 0 then
          log(string.format(
            "[Deserializer Error] %s manual section(s) still present on %s point %s after clear (%s) — payload sections NOT applied to this point (a partial replace would duplicate requests)",
            tostring(remaining), entity.name, tostring(point_data.point_index),
            count_ok and "remove refused/failed" or tostring(count_err)))
        else
          for _, sec_data in ipairs(point_data.sections) do
            if type(sec_data) ~= "table" then
              log(string.format("[Deserializer Error] malformed section record on %s (%s) — section skipped",
                entity.name, type(sec_data)))
            else
              local add_ok, section = pcall(function() return point.add_section(sec_data.group) end)
              if not add_ok or not section then
                log(string.format("[Deserializer Error] add_section(%s) failed on %s: %s",
                  tostring(sec_data.group), entity.name, tostring(add_ok and "nil section" or section)))
              else
                local is_new_group = sec_data.group ~= nil and registry_ok
                  and not existing_groups[sec_data.group]
                if is_new_group then
                  existing_groups[sec_data.group] = true
                  table.insert(created_groups, sec_data.group)
                end
                local adopted = sec_data.group ~= nil and not is_new_group
                if not adopted and type(sec_data.filters) == "table" then
                  for _, f in ipairs(sec_data.filters) do
                    if type(f) ~= "table" or type(f.value) ~= "table" then
                      log(string.format("[Deserializer Error] malformed section filter on %s — filter skipped", entity.name))
                    else
                      local slot = { value = f.value, min = f.min, max = f.max, import_from = f.import_from }
                      local slot_ok, slot_err = pcall(function() section.set_slot(f.index, slot) end)
                      if not slot_ok and f.import_from then
                        log(string.format("[Deserializer] set_slot with import_from='%s' failed on %s (%s) — retrying without import_from",
                          tostring(f.import_from), entity.name, tostring(slot_err)))
                        slot.import_from = nil
                        slot_ok, slot_err = pcall(function() section.set_slot(f.index, slot) end)
                      end
                      if not slot_ok then
                        log(string.format("[Deserializer Error] set_slot(%s) for %s on %s: %s",
                          tostring(f.index), tostring(f.value and f.value.name), entity.name, tostring(slot_err)))
                      end
                    end
                  end
                end
                local prop_ok, prop_err = pcall(function()
                  section.multiplier = sec_data.multiplier or 1
                  section.active = sec_data.active ~= false
                end)
                if not prop_ok then
                  log(string.format("[Deserializer Error] section multiplier/active on %s: %s", entity.name, tostring(prop_err)))
                end
              end
            end
          end
        end
      end
    end
  end
  return created_groups
end

local function restore_slot_filters(entity, entity_data)
  if not entity_data.entity_filters then
    return
  end

  if entity.type == "inserter" then
    local has_use_filters = entity_data.specific_data and entity_data.specific_data.use_filters
    
    if (has_use_filters or #entity_data.entity_filters > 0) and entity.inserter_filter_mode ~= nil then
      local filter_mode = entity_data.specific_data and entity_data.specific_data.filter_mode or "whitelist"
      local mode_success, mode_err = pcall(function()
        entity.inserter_filter_mode = filter_mode
      end)
      if not mode_success then
        log(string.format("[Deserializer] Failed to set inserter filter_mode: %s", tostring(mode_err)))
        return
      end
    end
    
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

end

function Deserializer.restore_entity_filters(entity, entity_data)
  if not entity.valid then
    return
  end
  restore_slot_filters(entity, entity_data)

  if entity_data.infinity_filters then
    local inf_ok, inf_err = pcall(function()
      entity.infinity_container_filters = entity_data.infinity_filters
    end)
    if not inf_ok then
      log(string.format("[Deserializer Error] infinity_container_filters for %s: %s", entity.name, tostring(inf_err)))
    end
  end
  if entity_data.infinity_pipe_filter then
    local pf_ok, pf_err = pcall(function()
      entity.set_infinity_pipe_filter(entity_data.infinity_pipe_filter)
    end)
    if not pf_ok then
      log(string.format("[Deserializer Error] set_infinity_pipe_filter for %s: %s", entity.name, tostring(pf_err)))
    end
  end
  if entity_data.infinity_remove_unfiltered ~= nil then
    local ru_ok, ru_err = pcall(function()
      entity.remove_unfiltered_items = entity_data.infinity_remove_unfiltered
    end)
    if not ru_ok then
      log(string.format("[Deserializer Error] remove_unfiltered_items for %s: %s", entity.name, tostring(ru_err)))
    end
  end
end

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
    local target = entity_map[conn.target_entity_id]

    if not target and type(conn.target_entity_id) == "string" and conn.target_entity_id:find("^pos_") then
      local x, y = conn.target_entity_id:match("pos_([%d%.%-]+)_([%d%.%-]+)")
      if x and y then
        x, y = tonumber(x), tonumber(y)
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
      local success, err = pcall(function()
        local source_connector = entity.get_wire_connector(conn.source_circuit_id, true)
        local target_connector = target.get_wire_connector(conn.target_circuit_id, true)

        if source_connector and target_connector then
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

function Deserializer.restore_proxy_targets(entity, entity_data, entity_map)
  if not entity.valid or entity.type ~= "proxy-container" then
    return 0
  end

  local data = entity_data.specific_data
  if not data or data.proxy_target_id == nil or data.proxy_target_inventory == nil then
    return 0
  end

  local target = entity_map[data.proxy_target_id]
  if not (target and target.valid) then
    log(string.format("[Deserializer] proxy-container at (%.1f, %.1f): target %s absent from entity_map — link dropped",
      entity.position.x, entity.position.y, tostring(data.proxy_target_id)))
    return 0
  end

  local linked = safe_call(string.format("proxy target for %s", entity.name), function()
    entity.proxy_target_entity = target
    entity.proxy_target_inventory = data.proxy_target_inventory
  end)

  return linked and 1 or 0
end

local function payload_copper_peers(entity_data, entity_map, copper)
  local peers = {}
  for _, conn in ipairs(entity_data.circuit_connections or {}) do
    if conn.source_circuit_id == copper and conn.target_circuit_id == copper then
      local peer = entity_map[conn.target_entity_id]
      if peer and peer.valid and peer.unit_number then
        peers[peer.unit_number] = true
      end
    end
  end
  return peers
end

local function restored_unit_numbers(entity_map)
  local restored = {}
  for _, entity in pairs(entity_map) do
    if entity and entity.valid and entity.unit_number then
      restored[entity.unit_number] = true
    end
  end
  return restored
end

local function is_pole_like(entity)
  if entity.type == "electric-pole" then
    return true
  end
  return entity.type == "entity-ghost" and entity.ghost_type == "electric-pole"
end

local SCRIPT_REACHABLE_WIRE_ORIGINS = { "player", "script" }

local function resolve_prune_origins()
  local origins = {}
  local names = {}
  for _, name in ipairs(SCRIPT_REACHABLE_WIRE_ORIGINS) do
    local value = defines.wire_origin[name]
    if value == nil then
      log(string.format("[Deserializer] pole copper prune: defines.wire_origin.%s is absent at this engine — "
        .. "copper held at that origin cannot be removed", name))
    else
      origins[#origins + 1] = value
      names[#names + 1] = name
    end
  end
  return origins, table.concat(names, "+")
end

local function disconnect_at_every_origin(connector, target, origins, origin_names, kind, label, tally)
  local removed = 0
  for _, origin in ipairs(origins) do
    if connector.disconnect_from(target.connector, origin) then
      removed = removed + 1
      tally.pruned = tally.pruned + 1
    end
  end
  if removed == 0 then
    log(string.format("[Deserializer] %s copper prune REMOVED NOTHING %s -> %s: no wire was held at any of "
      .. "the origins tried (%s), import continues", kind, label, target.label, origin_names))
  end
end

local function prune_one_pole(entity, entity_data, entity_map, restored, copper, label, tally, origins, origin_names)
  local peers = payload_copper_peers(entity_data, entity_map, copper)
  local connector = entity.get_wire_connector(copper, false)
  if not connector then
    return
  end

  local foreign = {}
  local seen = {}
  for _, conn in ipairs(connector.real_connections) do
    local peer_connector = conn.target
    local peer = peer_connector and peer_connector.owner
    if peer and peer.valid and peer.type == "electric-pole" and peer.unit_number
      and restored[peer.unit_number] and not peers[peer.unit_number] and not seen[peer.unit_number] then
      seen[peer.unit_number] = true
      foreign[#foreign + 1] = {
        connector = peer_connector,
        label = string.format("%s (%.1f, %.1f)", peer.name, peer.position.x, peer.position.y),
      }
    end
  end

  for _, target in ipairs(foreign) do
    disconnect_at_every_origin(connector, target, origins, origin_names, "pole", label, tally)
  end
end

local function prune_one_pole_ghost_wires(entity, entity_data, entity_map, restored, copper, label, tally,
  origins, origin_names)
  local peers = payload_copper_peers(entity_data, entity_map, copper)
  local connector = entity.get_wire_connector(copper, false)
  if not connector then
    return
  end

  local foreign = {}
  local seen = {}
  for _, conn in ipairs(connector.connections) do
    local peer_connector = conn.target
    local peer = peer_connector and peer_connector.owner
    if peer and peer.valid and (connector.is_ghost or peer_connector.is_ghost)
      and is_pole_like(peer) and peer.unit_number
      and restored[peer.unit_number] and not peers[peer.unit_number] and not seen[peer.unit_number] then
      seen[peer.unit_number] = true
      foreign[#foreign + 1] = {
        connector = peer_connector,
        label = string.format("%s (%.1f, %.1f)", peer.name, peer.position.x, peer.position.y),
      }
    end
  end

  for _, target in ipairs(foreign) do
    disconnect_at_every_origin(connector, target, origins, origin_names, "ghost pole", label, tally)
  end
end

function Deserializer.prune_pole_copper(entities_to_create, entity_map)
  local copper = defines.wire_connector_id.pole_copper
  local restored = restored_unit_numbers(entity_map)
  local tally = { pruned = 0 }
  local origins, origin_names = resolve_prune_origins()

  for _, entity_data in ipairs(entities_to_create) do
    local entity = entity_map[entity_data.entity_id]
    if entity and entity.valid and is_pole_like(entity) then
      local label = string.format("%s (%.1f, %.1f)", entity.name, entity.position.x, entity.position.y)

      if entity.type == "electric-pole" then
        local ok, err = pcall(prune_one_pole, entity, entity_data, entity_map, restored, copper, label, tally,
          origins, origin_names)
        if not ok then
          log(string.format("[Deserializer] pole copper prune THREW for %s: %s — that pole may keep copper the "
            .. "payload does not carry, import continues", label, tostring(err)))
        end
      end

      local ghost_ok, ghost_err = pcall(prune_one_pole_ghost_wires, entity, entity_data, entity_map, restored,
        copper, label, tally, origins, origin_names)
      if not ghost_ok then
        log(string.format("[Deserializer] ghost pole copper prune THREW for %s: %s — that pole may keep a "
          .. "planned wire the payload does not carry, import continues", label, tostring(ghost_err)))
      end
    end
  end

  return tally.pruned
end

return Deserializer

