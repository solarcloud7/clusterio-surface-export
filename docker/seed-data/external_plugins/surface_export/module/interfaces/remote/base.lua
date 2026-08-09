local json = require("modules/surface_export/core/json")

local Base = {}

function Base.json_wrap(fn)
  return function(...)
    local result = fn(...)
    if result ~= nil then
      return json.encode(result)
    end
    return "null"
  end
end

function Base.get_force(force_name)
  return game.forces[force_name or "player"]
end

function Base.find_platform(force, name_or_index)
  if not force or not force.valid then
    return nil
  end

  local index = tonumber(name_or_index)
  if index then
    local platform = force.platforms[index]
    if platform and platform.valid then
      return platform
    end
    return nil
  end

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
