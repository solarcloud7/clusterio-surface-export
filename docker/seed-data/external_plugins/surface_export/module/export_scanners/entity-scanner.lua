local Util = require("modules/surface_export/utils/util")
local GameUtils = require("modules/surface_export/utils/game-utils")
local EntityHandlers = require("modules/surface_export/export_scanners/entity-handlers")
local ConnectionScanner = require("modules/surface_export/export_scanners/connection-scanner")

local EntityScanner = {}

function EntityScanner.is_exportable_entity(entity)
  return entity ~= nil and entity.valid and entity.type ~= "item-entity" and entity.type ~= "character"
    and entity.type ~= "spider-leg"
end

function EntityScanner.scan_surface(surface)
  if not surface or not surface.valid then
    error("Invalid surface provided to scan_surface")
  end

  local entities = surface.find_entities_filtered({})
  local entity_data = {}

  local sortable_entities = {}
  for _, entity in pairs(entities) do
    if EntityScanner.is_exportable_entity(entity) then
      table.insert(sortable_entities, entity)
    end
  end

  table.sort(sortable_entities, function(a, b)
    local a_unit = a.unit_number
    local b_unit = b.unit_number
    if a_unit and b_unit then
      return a_unit < b_unit
    elseif a_unit then
      return true
    elseif b_unit then
      return false
    end

    if a.name ~= b.name then
      return a.name < b.name
    end

    if a.position.x ~= b.position.x then
      return a.position.x < b.position.x
    end

    if a.position.y ~= b.position.y then
      return a.position.y < b.position.y
    end

    return (a.direction or 0) < (b.direction or 0)
  end)

  for _, entity in ipairs(sortable_entities) do
    local serialized = EntityScanner.serialize_entity(entity)
    if serialized then
      table.insert(entity_data, serialized)
    end
  end

  local ground_items = EntityScanner.scan_items_on_ground(surface)
  for _, item_data in ipairs(ground_items) do
    table.insert(entity_data, item_data)
  end

  return entity_data
end

function EntityScanner.serialize_entity(entity)
  if not entity or not entity.valid then
    return nil
  end

  local entity_data = {
    entity_id = entity.unit_number or EntityScanner.make_stable_id(entity),
    name = entity.name,
    type = entity.type,
    position = Util.round_position(entity.position, 2),
    direction = entity.direction or 0,
    force = entity.force.name
  }

  if entity.health then
    entity_data.health = entity.health
  end

  if entity.quality and entity.quality.name ~= GameUtils.QUALITY_NORMAL then
    entity_data.quality = entity.quality.name
  end

  -- intentional probe; failure expected, no log
  local mirror_success, mirrored = pcall(function() return entity.mirroring end)
  if mirror_success and mirrored then
    entity_data.mirror = true
  end

  if entity.orientation then
    entity_data.orientation = entity.orientation
  end

  if entity.destructible == false then
    entity_data.destructible = false
  end

  local name_tag = GameUtils.safe_get(entity, "name_tag")
  if name_tag ~= nil and name_tag ~= "" then
    entity_data.name_tag = name_tag
  end

  local custom_status = GameUtils.safe_get(entity, "custom_status")
  if custom_status ~= nil then
    entity_data.custom_status = custom_status
  end

  local last_user = GameUtils.safe_get(entity, "last_user")
  if last_user ~= nil and last_user.valid then
    entity_data.last_user = last_user.name
  end

  local category = Util.get_entity_category(entity)

  local specific_data = EntityHandlers.handle_entity(entity, category)
  if specific_data then
    entity_data.specific_data = specific_data
  end

  local circuit_connections = ConnectionScanner.extract_circuit_connections(entity)
  if #circuit_connections > 0 then
    entity_data.circuit_connections = circuit_connections
  end

  local control_behavior = ConnectionScanner.extract_control_behavior(entity)
  if control_behavior then
    entity_data.control_behavior = control_behavior
  end

  local logistic_sections = ConnectionScanner.extract_logistic_sections(entity)
  if #logistic_sections > 0 then
    entity_data.logistic_sections = logistic_sections
  end

  local entity_filters = ConnectionScanner.extract_entity_filters(entity)
  if #entity_filters > 0 then
    entity_data.entity_filters = entity_filters
  end

  if entity.prototype.name:find("infinity") then
    local infinity_filters = ConnectionScanner.extract_infinity_filters(entity)
    if #infinity_filters > 0 then
      entity_data.infinity_filters = infinity_filters
    end
    -- intentional probe; failure expected on non-container infinity prototypes, no log
    local ru_ok, ru = pcall(function() return entity.remove_unfiltered_items end)
    if ru_ok and ru ~= nil then
      entity_data.infinity_remove_unfiltered = ru
    end

    local pipe_ok, pipe_filter = pcall(function() return entity.get_infinity_pipe_filter() end)
    if not pipe_ok then
      if entity.name == "infinity-pipe" then
        log(string.format("[entity-scanner] get_infinity_pipe_filter failed on %s: %s",
          entity.name, tostring(pipe_filter)))
      end
    elseif pipe_filter then
      entity_data.infinity_pipe_filter = pipe_filter
    end
  end

  if entity.type == "train-stop" and entity.backer_name then
    entity_data.backer_name = entity.backer_name
  end

  if entity.tags and next(entity.tags) then
    entity_data.tags = entity.tags
  end

  return entity_data
end

function EntityScanner.scan_items_on_ground(surface)
  local items = surface.find_entities_filtered({type = "item-entity"})
  local item_list = {}

  for _, item_entity in ipairs(items) do
    if item_entity.valid and item_entity.stack and item_entity.stack.valid_for_read then
      local stack = item_entity.stack
      table.insert(item_list, {
        type = "item-on-ground",
        name = stack.name,
        count = stack.count,
        position = Util.round_position(item_entity.position, 2),
        quality = stack.quality and stack.quality.name or GameUtils.QUALITY_NORMAL
      })
    end
  end

  return item_list
end

function EntityScanner.make_stable_id(entity)
  return GameUtils.make_stable_id(entity)
end

return EntityScanner
