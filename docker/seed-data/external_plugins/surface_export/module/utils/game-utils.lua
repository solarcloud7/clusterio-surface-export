-- FactorioSurfaceExport - Game Utilities
-- Helper functions specific to Factorio game mechanics

local GameUtils = {}

--- The default quality name used by Factorio for non-quality items
GameUtils.QUALITY_NORMAL = "normal"

--- Round a position to specified precision
--- @param position table: {x, y} position
--- @param precision number: Decimal places (default 1)
--- @return table: Rounded position
function GameUtils.round_position(position, precision)
  precision = precision or 1
  local multiplier = 10 ^ precision
  return {
    x = math.floor(position.x * multiplier + 0.5) / multiplier,
    y = math.floor(position.y * multiplier + 0.5) / multiplier
  }
end

--- Get entity type category (for handler dispatch)
--- @param entity LuaEntity: Entity to categorize
--- @return string: Entity type category
function GameUtils.get_entity_category(entity)
  local type = entity.type

  -- Group similar entity types
  if type:find("assembling%-machine") then
    return "assembling-machine"
  elseif type:find("furnace") then
    return "furnace"
  elseif type:find("transport%-belt") then
    return "transport-belt"
  elseif type:find("underground%-belt") then
    return "underground-belt"
  elseif type:find("splitter") then
    return "splitter"
  elseif type:find("inserter") then
    return "inserter"
  elseif type:find("container") or type:find("chest") then
    return "container"
  elseif type:find("storage%-tank") or type:find("fluid%-tank") then
    return "fluid-storage"
  elseif type:find("locomotive") or type:find("cargo%-wagon") or type:find("fluid%-wagon") then
    return "train"
  elseif type:find("combinator") then
    return "combinator"
  elseif type:find("turret") then
    return "turret"
  elseif type:find("mining%-drill") then
    return "mining-drill"
  elseif type:find("lab") then
    return "lab"
  elseif type:find("roboport") then
    return "roboport"
  elseif type:find("rocket%-silo") then
    return "rocket-silo"
  else
    return type
  end
end

--- Create a quality key for item tracking
--- @param item_name string: Item name
--- @param quality_name string: Quality name (normal, rare, epic, etc.)
--- @return string: Combined key
function GameUtils.make_quality_key(item_name, quality_name)
  if quality_name and quality_name ~= GameUtils.QUALITY_NORMAL then
    return string.format("%s:%s", item_name, quality_name)
  end
  return item_name
end

--- Create a fluid temperature key for fluid tracking
--- @param fluid_name string: Fluid name
--- @param temperature number: Fluid temperature
--- @return string: Combined key
function GameUtils.make_fluid_temp_key(fluid_name, temperature)
  return string.format("%s@%.1fC", fluid_name, temperature)
end

--- Parse a fluid temperature key back into components
--- @param key string: Fluid key (fluid_name@tempC)
--- @return string, number: fluid_name, temperature
function GameUtils.parse_fluid_temp_key(key)
  local name, temp_str = key:match("^(.+)@([%d%.%-]+)C$")
  if name and temp_str then
    return name, tonumber(temp_str)
  end
  return key, 15
end

--- Temperature threshold above which fluid packets may merge due to floating-point drift.
--- At >1,000,000°C IEEE 754 doubles lose precision; the engine may merge nearby packets
--- via weighted-average temperature, making exact-key validation unreliable.
GameUtils.HIGH_TEMP_THRESHOLD = 10000

--- Parse a quality key back into components
--- @param key string: Quality key (item_name or item_name:quality)
--- @return string, string: item_name, quality_name
function GameUtils.parse_quality_key(key)
  local parts = {}
  for part in key:gmatch("[^:]+") do
    table.insert(parts, part)
  end

  if #parts == 2 then
    return parts[1], parts[2]
  else
    return key, GameUtils.QUALITY_NORMAL
  end
end

--- Log a debug message (only in debug mode)
--- @param message string: Message to log
function GameUtils.debug_log(message)
  -- Can be toggled via settings in future versions
  -- log("[clusterio-surface-export DEBUG] " .. message)
end

-- ============================================================================
-- Shared Constants
-- ============================================================================

--- Entity types that support entity.active (can be deactivated/frozen).
--- Used by surface-lock.lua (freeze on export) and active_state_restoration.lua (restore on import).
GameUtils.ACTIVATABLE_ENTITY_TYPES = {
  -- Production
  ["assembling-machine"] = true,
  ["furnace"] = true,
  ["mining-drill"] = true,
  ["lab"] = true,
  ["rocket-silo"] = true,
  ["agricultural-tower"] = true,
  -- Power
  ["reactor"] = true,
  ["generator"] = true,
  ["burner-generator"] = true,
  ["boiler"] = true,
  ["fusion-reactor"] = true,
  ["fusion-generator"] = true,
  -- Logistics - Item transport
  ["inserter"] = true,
  -- Note: Belts cannot be disabled (since Factorio 0.17). This is fine -
  -- with inserters/loaders frozen, no items can enter or leave belts.
  ["loader"] = true,
  ["loader-1x1"] = true,
  -- Logistics - Fluid transport
  ["pump"] = true,
  ["offshore-pump"] = true,
  -- Logistics - Robots
  ["roboport"] = true,
  -- Misc
  ["beacon"] = true,
  ["radar"] = true,
  -- Space platform specific
  ["thruster"] = true,
  ["asteroid-collector"] = true,
  ["cargo-bay"] = true,
  ["space-platform-hub"] = true,
  -- Planet logistics (for future surface transfers)
  ["cargo-landing-pad"] = true,
}

--- Belt entity types (transport-belt, underground-belt, splitter).
--- Items on belts cannot be deactivated and require special handling during export/import.
GameUtils.BELT_ENTITY_TYPES = {
  ["transport-belt"] = true,
  ["underground-belt"] = true,
  ["splitter"] = true,
}

-- ============================================================================
-- Shared Helpers
-- ============================================================================

--- Generate a deterministic identifier for entities without unit_number.
--- Format: "name@x.xxx,y.yyy#direction[:orientation]"
--- Used by both entity-scanner.lua (export) and surface-lock.lua (frozen_states).
--- @param entity LuaEntity
--- @return string
function GameUtils.make_stable_id(entity)
  local position = entity.position or {x = 0, y = 0}
  local orientation_part = entity.orientation and string.format(":%.3f", entity.orientation) or ""
  return string.format("%s@%.3f,%.3f#%s%s",
    entity.name,
    position.x,
    position.y,
    entity.direction or 0,
    orientation_part)
end

--- Safely read a property from an object, returning nil on error.
--- Replaces the common `pcall(function() return obj.prop end)` pattern.
--- @param obj table: Object to read from
--- @param property string: Property name
--- @return any|nil: Property value, or nil if read fails
function GameUtils.safe_get(obj, property)
  local ok, val = pcall(function() return obj[property] end)
  if ok then return val end
  return nil
end

--- Extract color from an entity, returning a normalized color table or nil.
--- Replaces the repeated pcall-color-extraction pattern in entity handlers.
--- @param entity LuaEntity
--- @return table|nil: {r, g, b, a} or nil
function GameUtils.extract_color(entity)
  local ok, color = pcall(function() return entity.color end)
  if ok and color then
    return { r = color.r or 0, g = color.g or 0, b = color.b or 0, a = color.a or 1 }
  end
  return nil
end

return GameUtils
