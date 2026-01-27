-- FactorioSurfaceExport - JSON and File Compatibility Layer
-- Handles JSON encoding/decoding and file I/O across different Factorio versions

-- NOTE: This module is injected into a save via Clusterio, not loaded as a Factorio mod.
-- That means mod-qualified paths like "__SomeMod__/json" are not available.
-- Prefer Factorio-provided JSON APIs (helpers/game) and fall back with a clear error.

local JsonCompat = {}

--- Determine if a table behaves like an array (1..n integer keys)
--- @param t table
--- @return boolean
local function is_array(t)
  if type(t) ~= "table" then
    return false
  end

  local count = 0
  local max_index = 0
  for k, _ in pairs(t) do
    if type(k) ~= "number" or k <= 0 or math.floor(k) ~= k then
      return false
    end
    count = count + 1
    if k > max_index then
      max_index = k
    end
  end

  return max_index == count
end

local JSON_ESCAPES = {
  ['"'] = '\\"',
  ["\\"] = "\\\\",
  ["\b"] = "\\b",
  ["\f"] = "\\f",
  ["\n"] = "\\n",
  ["\r"] = "\\r",
  ["\t"] = "\\t"
}

local function escape_json_string(str)
  local buffer = {}
  for i = 1, #str do
    local ch = str:sub(i, i)
    local replacement = JSON_ESCAPES[ch]
    if replacement then
      buffer[#buffer + 1] = replacement
    else
      local byte = string.byte(ch)
      if byte < 32 then
        buffer[#buffer + 1] = string.format("\\u%04x", byte)
      else
        buffer[#buffer + 1] = ch
      end
    end
  end

  return table.concat(buffer)
end

local function encode_json(value, visited)
  local value_type = type(value)

  if value_type == "nil" then
    return "null"
  elseif value_type == "boolean" then
    return value and "true" or "false"
  elseif value_type == "number" then
    return tostring(value)
  elseif value_type == "string" then
    return string.format('"%s"', escape_json_string(value))
  elseif value_type == "table" then
    visited = visited or {}
    if visited[value] then
      error("Cannot encode JSON with circular references")
    end
    visited[value] = true

    local parts = {}
    if is_array(value) then
      for i = 1, #value do
        table.insert(parts, encode_json(value[i], visited))
      end
      visited[value] = nil
      return string.format('[%s]', table.concat(parts, ','))
    else
      for k, v in pairs(value) do
        if type(k) ~= "string" then
          error("JSON object keys must be strings")
        end
        local encoded_key = string.format('"%s"', escape_json_string(k))
        table.insert(parts, string.format('%s:%s', encoded_key, encode_json(v, visited)))
      end
      visited[value] = nil
      return string.format('{%s}', table.concat(parts, ','))
    end
  else
    error(string.format("Unsupported JSON type: %s", value_type))
  end
end

--- Encode a Lua table into JSON (internal implementation)
--- @param value any
--- @return string
function JsonCompat.to_json(value)
  return encode_json(value, {})
end

--- Encode a Lua table into JSON using whatever API is available
--- Falls back to the internal encoder when necessary
--- @param value any
--- @return string|nil, string|nil
function JsonCompat.encode_json_compat(value)
  -- Prefer game.table_to_json when available, but don't crash if missing
  if game then
    local ok, result = pcall(function()
      if game.table_to_json then
        return game.table_to_json(value)
      end
      return nil
    end)
    if ok and result ~= nil then
      return result
    end
    -- If not ok, assume API is unavailable and fall through to fallbacks
  end

  -- Try LuaHelpers.table_to_json when enabled
  local ok_helpers, helpers_result = pcall(function()
    if helpers and helpers.table_to_json then
      return helpers.table_to_json(value)
    end
    return nil
  end)
  if ok_helpers and helpers_result ~= nil then
    return helpers_result
  end

  -- Fallback to internal encoder
  local ok, result = pcall(JsonCompat.to_json, value)
  if ok then
    return result
  end

  return nil, result
end

--- Decode JSON using whichever API is exposed by the runtime
--- @param json_string string
--- @return table|nil, string|nil
function JsonCompat.json_to_table_compat(json_string)
  -- Try Factorio 2.0 helpers first (most efficient)
  if helpers and helpers.json_to_table then
    local ok, result = pcall(helpers.json_to_table, json_string)
    if ok and result then return result end
  end

  -- Try Factorio 0.17-1.1 game API (Safe check for 2.0 compatibility)
  -- Accessing missing keys on LuaGameScript errors in 2.0
  if game then
    local status, has_func = pcall(function() return game.json_to_table end)
    if status and has_func then
      local ok, result = pcall(game.json_to_table, json_string)
      if ok and result then return result end
    end
  end

  return nil, "No JSON decoder available (missing helpers.json_to_table and game.json_to_table)"
end

--- Write a file to script-output using any available API
--- @param filename string
--- @param contents string
--- @param append boolean|nil
--- @param for_player uint32|nil
--- @return boolean, string|nil
function JsonCompat.write_file_compat(filename, contents, append, for_player)
  -- Prefer game.write_file when available, but don't crash if missing
  if game then
    local ok, result = pcall(function()
      if game.write_file then
        game.write_file(filename, contents, append)
        return true
      end
      return false, "write_file API unavailable on game"
    end)
    if ok and result == true then
      return true
    end
    if ok and type(result) == "table" and result[1] == false then
      return false, result[2]
    end
  end

  -- Try LuaHelpers.write_file when enabled
  local ok_helpers, helpers_error = pcall(function()
    if helpers and helpers.write_file then
      helpers.write_file(filename, contents, append, for_player)
      return true
    end
    return false, "helpers.write_file API unavailable"
  end)
  if ok_helpers and helpers_error == true then
    return true
  end

  return false, "No available write_file implementation"
end

--- Read a file from script-output using any available API
--- @param filename string
--- @return string|nil, string|nil
function JsonCompat.read_file_compat(filename)
  -- In Factorio 2.0, game.read_file doesn't exist in runtime
  -- Try helpers.read_file if available
  if helpers and helpers.read_file then
    local ok, result = pcall(helpers.read_file, filename)
    if ok then
      return result
    else
      return nil, "Failed to read file via helpers: " .. tostring(result)
    end
  end
  
  return nil, "File reading not available - helpers.read_file not found"
end

return JsonCompat
