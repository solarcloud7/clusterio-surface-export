-- Remote Interface: Base utilities
-- Common helper functions for remote interface modules

local json = require("modules/surface_export/core/json")

local Base = {}

--- Wrap any function to return JSON-encoded result
--- @param fn function: Function that returns a table or nil
--- @return function: Wrapped function that returns JSON string
function Base.json_wrap(fn)
  return function(...)
    local result = fn(...)
    if result ~= nil then
      return json.encode(result)
    end
    return "null"
  end
end

--- Get force by name with default fallback
--- @param force_name string|nil: Force name (defaults to "player")
--- @return LuaForce|nil: The force or nil if not found
function Base.get_force(force_name)
  return game.forces[force_name or "player"]
end

--- Find platform by name or index
--- @param force LuaForce: The force to search
--- @param name_or_index string|number: Platform name or 1-based index
--- @return LuaSpacePlatform|nil: The platform or nil if not found
function Base.find_platform(force, name_or_index)
  if not force or not force.valid then
    return nil
  end
  
  local index = tonumber(name_or_index)
  if index then
    -- Find by index (1-based)
    local count = 0
    for _, platform in pairs(force.platforms) do
      if platform.valid then
        count = count + 1
        if count == index then
          return platform
        end
      end
    end
  else
    -- Find by name
    for _, platform in pairs(force.platforms) do
      if platform.valid and platform.name == name_or_index then
        return platform
      end
    end
  end
  return nil
end

--- Standard print function that works for both player and RCON
--- @param player_index number|nil: Player index or nil for RCON
--- @return function: Print function
function Base.get_print_fn(player_index)
  if player_index then
    local player = game.get_player(player_index)
    if player then
      return function(msg) player.print(msg) end
    end
  end
  return function(msg) rcon.print(msg) end
end

return Base
