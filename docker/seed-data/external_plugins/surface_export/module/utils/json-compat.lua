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

function JsonCompat.to_json(value)
  return encode_json(value, {})
end

function JsonCompat.encode_json_compat(value)
  if helpers and helpers.table_to_json then
    local ok, result = pcall(helpers.table_to_json, value)
    if ok and result ~= nil then
      return result
    end
    if not ok then
      log(string.format("[JsonCompat] helpers.table_to_json failed, falling back to the internal encoder: %s",
        tostring(result)))
    end
  else
    log("[JsonCompat] helpers.table_to_json unavailable, falling back to the internal encoder")
  end

  local ok, result = pcall(JsonCompat.to_json, value)
  if ok then
    return result
  end

  log(string.format("[JsonCompat] internal JSON encoder failed (all encoders exhausted): %s", tostring(result)))
  return nil, result
end

function JsonCompat.json_to_table_compat(json_string)
  if helpers and helpers.json_to_table then
    local ok, result = pcall(helpers.json_to_table, json_string)
    if ok and result then return result end
    if not ok then
      log(string.format("[JsonCompat] helpers.json_to_table failed: %s", tostring(result)))
    end
    return nil, "helpers.json_to_table could not decode the input"
  end

  return nil, "No JSON decoder available (helpers.json_to_table missing)"
end

function JsonCompat.write_file_compat(filename, contents, append, for_player)
  if helpers and helpers.write_file then
    local ok, err = pcall(helpers.write_file, filename, contents, append, for_player)
    if ok then
      return true
    end
    log(string.format("[JsonCompat] helpers.write_file failed: %s", tostring(err)))
    return false, tostring(err)
  end

  return false, "No available write_file implementation (helpers.write_file missing)"
end

function JsonCompat.read_file_compat(filename)
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
