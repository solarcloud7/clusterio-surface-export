-- FactorioSurfaceExport - JSON and File Compatibility Layer
-- Handles JSON encoding/decoding and file I/O across different Factorio versions

-- NOTE: This module is injected into a save via Clusterio, not loaded as a Factorio mod.
-- That means mod-qualified paths like "__SomeMod__/json" are not available.
-- Prefer Factorio-provided JSON APIs (helpers/game) and fall back with a clear error.

local JsonCompat = {}

local TableUtils = require("modules/surface_export/utils/table-utils")

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
    if TableUtils.is_array(value) then
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
    -- ok && result==nil → API genuinely unavailable (normal fallthrough, no log).
    -- not ok → game.table_to_json EXISTED and THREW: a real encode error we must not swallow.
    if not ok then
      log(string.format("[JsonCompat] game.table_to_json failed, falling back: %s", tostring(result)))
    end
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
  if not ok_helpers then
    log(string.format("[JsonCompat] helpers.table_to_json failed, falling back: %s", tostring(helpers_result)))
  end

  -- Fallback to internal encoder
  local ok, result = pcall(JsonCompat.to_json, value)
  if ok then
    return result
  end

  -- All encoders exhausted: log the genuine total-failure before returning the error to the caller.
  log(string.format("[JsonCompat] internal JSON encoder failed (all encoders exhausted): %s", tostring(result)))
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
    -- Decoder EXISTED and THREW (e.g. malformed JSON): log so it isn't masked as "no decoder available".
    if not ok then
      log(string.format("[JsonCompat] helpers.json_to_table failed: %s", tostring(result)))
    end
  end

  -- Try Factorio 0.17-1.1 game API (Safe check for 2.0 compatibility)
  -- Accessing missing keys on LuaGameScript errors in 2.0
  if game then
    -- intentional probe; failure expected (game.json_to_table is absent in 2.0 and the key access errors), no log
    local status, has_func = pcall(function() return game.json_to_table end)
    if status and has_func then
      local ok, result = pcall(game.json_to_table, json_string)
      if ok and result then return result end
      if not ok then
        log(string.format("[JsonCompat] game.json_to_table failed: %s", tostring(result)))
      end
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
    -- not ok → game.write_file EXISTED and THREW (e.g. disk/filename error): log so it isn't
    -- masked as "No available write_file implementation" below.
    if not ok then
      log(string.format("[JsonCompat] game.write_file failed, falling back: %s", tostring(result)))
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
  if not ok_helpers then
    log(string.format("[JsonCompat] helpers.write_file failed: %s", tostring(helpers_error)))
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
