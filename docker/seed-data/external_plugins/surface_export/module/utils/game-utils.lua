-- FactorioSurfaceExport - Game Utilities
-- Helper functions specific to Factorio game mechanics

local GameUtils = {}

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
  if quality_name and quality_name ~= "normal" then
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
    return key, "normal"
  end
end

--- Log a debug message (only in debug mode)
--- @param message string: Message to log
function GameUtils.debug_log(message)
  -- Can be toggled via settings in future versions
  -- log("[FactorioSurfaceExport DEBUG] " .. message)
end

return GameUtils
