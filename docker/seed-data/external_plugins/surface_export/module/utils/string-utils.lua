local StringUtils = {}

function StringUtils.format_timestamp(tick)
  local seconds = math.floor(tick / 60)
  local minutes = math.floor(seconds / 60)
  local hours = math.floor(minutes / 60)
  local days = math.floor(hours / 24)

  seconds = seconds % 60
  minutes = minutes % 60
  hours = hours % 24

  return string.format("%04d-%02d-%02dT%02d:%02d:%02d",
    1970, 1, 1 + days, hours, minutes, seconds)
end

function StringUtils.sanitize_filename(filename)
  local sanitized = filename:gsub("[%s/<>:\"|?*\\]+", "_")
  sanitized = sanitized:gsub("^_+", ""):gsub("_+$", "")
  if #sanitized > 200 then
    sanitized = sanitized:sub(1, 200)
  end
  return sanitized
end

function StringUtils.simple_checksum(data_string)
  local hash = 0
  for i = 1, #data_string do
    local char_code = string.byte(data_string, i)
    hash = (hash * 31 + char_code) % 4294967296
  end
  return string.format("%08x", hash)
end

return StringUtils
