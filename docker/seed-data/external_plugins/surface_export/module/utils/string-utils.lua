-- FactorioSurfaceExport - String Utilities
-- Helper functions for string operations and formatting

local StringUtils = {}

--- Format a Factorio tick as ISO 8601 timestamp
--- @param tick number: Game tick to convert
--- @return string: ISO 8601 formatted timestamp
function StringUtils.format_timestamp(tick)
  -- Factorio ticks: 60 ticks per second
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

--- Sanitize a filename by removing invalid characters
--- @param filename string: Filename to sanitize
--- @return string: Sanitized filename
function StringUtils.sanitize_filename(filename)
  -- Replace spaces and invalid characters with underscores
  local sanitized = filename:gsub("[%s/<>:\"|?*\\]+", "_")
  -- Remove leading/trailing underscores
  sanitized = sanitized:gsub("^_+", ""):gsub("_+$", "")
  -- Limit length
  if #sanitized > 200 then
    sanitized = sanitized:sub(1, 200)
  end
  return sanitized
end

--- Generate a simple hash/checksum for data verification
--- Uses a basic checksum algorithm (not cryptographically secure)
--- @param data_string string: String to hash
--- @return string: Hex checksum
function StringUtils.simple_checksum(data_string)
  local hash = 0
  for i = 1, #data_string do
    local char_code = string.byte(data_string, i)
    hash = (hash * 31 + char_code) % 4294967296  -- 2^32
  end
  return string.format("%08x", hash)
end

return StringUtils
