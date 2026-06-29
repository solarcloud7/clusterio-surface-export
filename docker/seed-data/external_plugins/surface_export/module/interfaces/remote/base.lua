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

--- Find a platform by its UNIQUE index (preferred) or by display name. A purely-numeric argument is treated
--- as the unique `platform.index` and looked up DIRECTLY in `force.platforms` (which Factorio keys by that
--- unique index — a possibly-sparse map after deletions, NOT a positional ordinal). A non-numeric argument
--- is matched against `platform.name`; since names are mutable + non-unique, name matching is for the
--- interactive tooling boundary only and **fails loud on ambiguity** (≥2 matches → nil + error + log) rather
--- than silently returning the first match. Numeric-string platform names are therefore treated as indices
--- (the documented trade-off — emit the unique index, not the name, across boundaries).
--- @param force LuaForce: The force to search
--- @param name_or_index string|number: Unique platform index (preferred) or display name
--- @return LuaSpacePlatform|nil platform, string|nil error
function Base.find_platform(force, name_or_index)
  if not force or not force.valid then
    return nil
  end

  local index = tonumber(name_or_index)
  if index then
    -- Direct unique-index lookup (NOT count-to-Nth — that disagreed with the index when the map is sparse).
    local platform = force.platforms[index]
    if platform and platform.valid then
      return platform
    end
    return nil
  end

  -- Name match: collect ALL matches, fail loud on ambiguity (never silent first-match on a non-unique key).
  local match, count = nil, 0
  for _, platform in pairs(force.platforms) do
    if platform.valid and platform.name == name_or_index then
      match = platform
      count = count + 1
    end
  end
  if count > 1 then
    local err = string.format("ambiguous: %d platforms named '%s' — use the unique platform index",
      count, tostring(name_or_index))
    log("[Base.find_platform] " .. err)
    return nil, err
  end
  return match
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
