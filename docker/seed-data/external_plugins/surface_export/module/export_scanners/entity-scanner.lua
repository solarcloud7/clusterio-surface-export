-- FactorioSurfaceExport - Entity Scanner
-- Scans all entities on a surface and orchestrates serialization

local Util = require("modules/surface_export/utils/util")
local GameUtils = require("modules/surface_export/utils/game-utils")
local EntityHandlers = require("modules/surface_export/export_scanners/entity-handlers")
local ConnectionScanner = require("modules/surface_export/export_scanners/connection-scanner")

local EntityScanner = {}

--- Whether the export serializes `entity` as a normal entity record. SINGLE source of truth for the
--- export-exclusion set — BOTH the sync `scan_surface` and the async `ExportPipeline.process_batch` call
--- this, so the two export paths cannot drift (a drift would silently re-open a data-integrity hole).
--- Excludes:
---   * `item-entity` — loose ground items; captured separately WITH their item payload by the atomic
---     ground-item scan (`scan_items_on_ground` / export-pipeline `complete()`), so the generic serializer
---     must not emit a stackless, unrestorable "item-on-ground" record (silent loss).
---   * `character` — a player's body (a PASSENGER), never cargo; serializing it would recreate the body +
---     equipped gear on the dest while the source original is evacuated at the delete = cross-instance
---     DUPLICATION (the cardinal sin, Pitfalls #28/#29). Passengers are handled by
---     `Gateway.evacuate_passengers`. (Corpses stay included: not evacuated, so copying = relocation, no dup.)
--- @param entity LuaEntity|nil
--- @return boolean
function EntityScanner.is_exportable_entity(entity)
  -- spider-leg: legs are OWNED by their spider-vehicle (creating the vehicle spawns them; a
  -- standalone leg create always fails). Serializing them only manufactures guaranteed creation
  -- failures downstream — measured 2026-07-19: the selection-lab paste of the equipment-grid pad
  -- rolled back on exactly its 8 leg records; transfers only balanced because 8 failed leg creates
  -- happened to be replaced by the 8 legs the restored spidertron spawned itself.
  return entity ~= nil and entity.valid and entity.type ~= "item-entity" and entity.type ~= "character"
    and entity.type ~= "spider-leg"
end

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
  if entity.quality and entity.quality.name ~= GameUtils.QUALITY_NORMAL then
    entity_data.quality = entity.quality.name
  end

  -- MIRROR (whether entity is mirrored)
  -- intentional probe; failure expected, no log
  local mirror_success, mirrored = pcall(function() return entity.mirrored end)
  if mirror_success and mirrored then
    entity_data.mirror = true
  end

  -- Orientation (for trains, vehicles)
  if entity.orientation then
    entity_data.orientation = entity.orientation
  end

  -- destructible: captured only when false (default true is omitted — lean payload). The freeze
  -- convention (fixtures set destructible=false) must survive paste AND transfer; found missing
  -- live 2026-07-20 via the pad paste-fingerprint depth.
  if entity.destructible == false then
    entity_data.destructible = false
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

  -- Extract MANUAL logistic sections (2.0 sections API) — on the hub these are the platform's
  -- pending item requests; a setting, invisible to the exact gate, lost silently without this.
  local logistic_sections = ConnectionScanner.extract_logistic_sections(entity)
  if #logistic_sections > 0 then
    entity_data.logistic_sections = logistic_sections
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
    -- remove_unfiltered_items rides with the filters (the fill-harness contract in
    -- docs/testing.md depends on both surviving a clone/copy).
    -- intentional probe; failure expected on non-container infinity prototypes, no log
    local ru_ok, ru = pcall(function() return entity.remove_unfiltered_items end)
    if ru_ok and ru ~= nil then
      entity_data.infinity_remove_unfiltered = ru
    end

    -- INFINITY PIPE — a METHOD pair, not a property. The chest above uses the
    -- `infinity_container_filters` PROPERTY; the pipe uses get_/set_infinity_pipe_filter().
    -- Probed live on the 2.1.11 pin (2026-07-26): reading `entity.infinity_pipe_filter` THROWS,
    -- and `infinity_container_filters` THROWS on a pipe — so mirroring the chest's shape here,
    -- the obvious move, would have been wrong. get() returns nil (unfiltered) or
    --   { name = "fusion-plasma", percentage = 1, temperature = 1000000, mode = "at-least" }
    -- Store the WHOLE table: temperature and mode are load-bearing (a fusion-plasma pipe filtered
    -- at 1e6 K is not the same fixture as an unfiltered one), and a partial {name, percentage}
    -- capture would drop them silently — the same partial-capture bug one layer down.
    --
    -- Until now nothing carried this at all: an infinity pipe transferred as an ordinary pipe and
    -- lost its filter. The exact gate cannot see it, because a filter is a SETTING, not contents —
    -- the platform arrives with correct items and fluids and passes clean. That is precisely how
    -- the CHEST version (restore_slot_filters, deserializer.lua) went unnoticed until 2026-07-18.
    local pipe_ok, pipe_filter = pcall(function() return entity.get_infinity_pipe_filter() end)
    if not pipe_ok then
      -- Only log where the method should exist; other "infinity*" prototypes legitimately lack it.
      if entity.name == "infinity-pipe" then
        log(string.format("[entity-scanner] get_infinity_pipe_filter failed on %s: %s",
          entity.name, tostring(pipe_filter)))
      end
    elseif pipe_filter then
      entity_data.infinity_pipe_filter = pipe_filter
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
        quality = stack.quality and stack.quality.name or GameUtils.QUALITY_NORMAL
      })
    end
  end

  return item_list
end

--- Generate a deterministic identifier for entities without unit_number
--- Delegates to GameUtils.make_stable_id (single source of truth)
--- @param entity LuaEntity
--- @return string
function EntityScanner.make_stable_id(entity)
  return GameUtils.make_stable_id(entity)
end

return EntityScanner
