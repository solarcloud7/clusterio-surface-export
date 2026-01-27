-- FactorioSurfaceExport - Entity Scanner
-- Scans all entities on a surface and orchestrates serialization

local Util = require("modules/surface_export/utils/util")
local EntityHandlers = require("modules/surface_export/export_scanners/entity-handlers")
local ConnectionScanner = require("modules/surface_export/export_scanners/connection-scanner")

local EntityScanner = {}

--- Scan all entities on a surface
--- @param surface LuaSurface: The surface to scan
--- @return table: Array of serialized entity data
function EntityScanner.scan_surface(surface)
  if not surface or not surface.valid then
    error("Invalid surface provided to scan_surface")
  end

  -- Find all entities on the surface
  local entities = surface.find_entities_filtered({})
  local entity_data = {}

  local sortable_entities = {}
  for _, entity in pairs(entities) do
    if entity.valid and entity.type ~= "item-entity" then
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

  -- Process each entity
  for _, entity in ipairs(sortable_entities) do
    local serialized = EntityScanner.serialize_entity(entity)
    if serialized then
      table.insert(entity_data, serialized)
    end
  end

  -- Scan items on ground (item-entity type)
  local ground_items = EntityScanner.scan_items_on_ground(surface)
  for _, item_data in ipairs(ground_items) do
    table.insert(entity_data, item_data)
  end

  return entity_data
end

--- Serialize a single entity
--- @param entity LuaEntity: The entity to serialize
--- @return table|nil: Serialized entity data, or nil if entity should be skipped
function EntityScanner.serialize_entity(entity)
  if not entity or not entity.valid then
    return nil
  end

  -- Base entity data (common to all entities)
  local entity_data = {
    entity_id = entity.unit_number or EntityScanner.make_stable_id(entity),
    name = entity.name,
    type = entity.type,
    position = Util.round_position(entity.position, 2),
    direction = entity.direction or 0,
    force = entity.force.name
  }

  -- Health (if applicable)
  if entity.health then
    entity_data.health = entity.health
  end

  -- Quality (Factorio 2.0 Space Age feature)
  if entity.quality and entity.quality.name ~= "normal" then
    entity_data.quality = entity.quality.name
  end

  -- MIRROR (whether entity is mirrored)
  local mirror_success, mirrored = pcall(function() return entity.mirrored end)
  if mirror_success and mirrored then
    entity_data.mirror = true
  end

  -- Orientation (for trains, vehicles)
  if entity.orientation then
    entity_data.orientation = entity.orientation
  end

  -- Get entity category for handler dispatch
  local category = Util.get_entity_category(entity)

  -- Call entity-specific handler
  local specific_data = EntityHandlers.handle_entity(entity, category)
  if specific_data then
    entity_data.specific_data = specific_data
  end

  -- CRITICAL: Extract circuit connections (red/green wires)
  local circuit_connections = ConnectionScanner.extract_circuit_connections(entity)
  if #circuit_connections > 0 then
    entity_data.circuit_connections = circuit_connections
  end

  -- CRITICAL: Extract power connections (copper cables for electric poles)
  local power_connections = ConnectionScanner.extract_power_connections(entity)
  if #power_connections > 0 then
    entity_data.power_connections = power_connections
  end

  -- CRITICAL: Extract control behavior (circuit conditions, filters, signals)
  local control_behavior = ConnectionScanner.extract_control_behavior(entity)
  if control_behavior then
    entity_data.control_behavior = control_behavior
  end

  -- Extract logistic requests (requester/buffer chests)
  local logistic_requests = ConnectionScanner.extract_logistic_requests(entity)
  if #logistic_requests > 0 then
    entity_data.logistic_requests = logistic_requests
  end

  -- Extract entity filters (filter inserters, loaders, cargo wagons)
  local entity_filters = ConnectionScanner.extract_entity_filters(entity)
  if #entity_filters > 0 then
    entity_data.entity_filters = entity_filters
  end

  -- Extract infinity container filters (testing/creative mode)
  if entity.prototype.name:find("infinity") then
    local infinity_filters = ConnectionScanner.extract_infinity_filters(entity)
    if #infinity_filters > 0 then
      entity_data.infinity_filters = infinity_filters
    end
  end

  -- Train station name (custom backer name)
  if entity.type == "train-stop" and entity.backer_name then
    entity_data.backer_name = entity.backer_name
  end

  -- Entity tags (custom mod data)
  if entity.tags and next(entity.tags) then
    entity_data.tags = entity.tags
  end

  return entity_data
end

--- Scan items on the ground
--- @param surface LuaSurface: The surface to scan
--- @return table: Array of item entities
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
        quality = stack.quality and stack.quality.name or "normal"
      })
    end
  end

  return item_list
end

--- Count entities by type (for statistics)
--- @param entity_data table: Array of serialized entities
--- @return table: Table of type = count pairs
function EntityScanner.count_by_type(entity_data)
  local counts = {}

  for _, entity in ipairs(entity_data) do
    local type_name = entity.type or "unknown"
    counts[type_name] = (counts[type_name] or 0) + 1
  end

  return counts
end

--- Generate a deterministic identifier for entities without unit_number
--- @param entity LuaEntity
--- @return string
function EntityScanner.make_stable_id(entity)
  local position = entity.position or {x = 0, y = 0}
  local orientation_part = entity.orientation and string.format(":%.3f", entity.orientation) or ""
  return string.format("%s@%.3f,%.3f#%s%s",
    entity.name,
    position.x,
    position.y,
    entity.direction or 0,
    orientation_part)
end

return EntityScanner
