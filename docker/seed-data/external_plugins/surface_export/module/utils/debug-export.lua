-- Debug Export Utility
-- Exports platform JSON files for comparison when debug_mode is enabled

local Util = require("modules/surface_export/utils/util")

local DebugExport = {}

--- Check if debug mode is enabled
--- @return boolean
function DebugExport.is_enabled()
  local enabled = storage.surface_export_config and storage.surface_export_config.debug_mode == true
  if not enabled then
    -- Log the actual config value to help diagnose type mismatches (e.g., "true" vs true)
    local config = storage.surface_export_config
    if config then
      log(string.format("[DebugExport] is_enabled=false: debug_mode=%s (type=%s)",
        tostring(config.debug_mode), type(config.debug_mode)))
    else
      log("[DebugExport] is_enabled=false: surface_export_config is nil")
    end
  end
  return enabled
end

--- Write a JSON file to script-output for debugging
--- @param filename string: The output filename (will be prefixed with "debug_")
--- @param data table: The data to serialize to JSON
--- @param description string: Optional description to log
function DebugExport.write_json(filename, data, description)
  if not DebugExport.is_enabled() then
    return false
  end
  
  local full_filename = "debug_" .. filename
  
  -- Use pcall to safely encode JSON in case data is too large or has unsupported types
  local success, json_data = pcall(function()
    return Util.encode_json_compat(data)
  end)
  
  if not success then
    log(string.format("[DebugExport] ERROR: Failed to encode JSON for %s: %s", full_filename, tostring(json_data)))
    return false
  end
  
  if not json_data or type(json_data) ~= "string" then
    log(string.format("[DebugExport] ERROR: JSON encoding returned nil or non-string for %s", full_filename))
    return false
  end
  
  local write_success, write_err = Util.write_file_compat(full_filename, json_data, false)
  
  if not write_success then
    log(string.format("[DebugExport] ERROR: Failed to write file %s: %s", full_filename, tostring(write_err)))
    return false
  end
  
  if description then
    log(string.format("[DebugExport] %s -> %s (%d bytes)", description, full_filename, #json_data))
  else
    log(string.format("[DebugExport] Wrote %s (%d bytes)", full_filename, #json_data))
  end
  
  return true
end

--- Export platform data before transfer (source platform)
--- @param platform_data table: The exported platform data
--- @param platform_name string: Name of the platform
function DebugExport.export_source_platform(platform_data, platform_name)
  if not DebugExport.is_enabled() then
    log(string.format("[DebugExport] Skipping source platform export for '%s': debug mode disabled", tostring(platform_name)))
    return false
  end
  
  local safe_name = string.gsub(platform_name or "unknown", "[^%w_-]", "_")
  local filename = string.format("source_platform_%s_%d.json", safe_name, game.tick)
  
  return DebugExport.write_json(filename, platform_data, "Source platform export: " .. (platform_name or "unknown"))
end

--- Export platform data after import (destination platform)
--- @param platform_data table: The imported/scanned platform data
--- @param platform_name string: Name of the platform
function DebugExport.export_destination_platform(platform_data, platform_name)
  if not DebugExport.is_enabled() then
    log(string.format("[DebugExport] Skipping destination platform export for '%s': debug mode disabled", tostring(platform_name)))
    return false
  end
  
  local safe_name = string.gsub(platform_name or "unknown", "[^%w_-]", "_")
  local filename = string.format("destination_platform_%s_%d.json", safe_name, game.tick)
  
  return DebugExport.write_json(filename, platform_data, "Destination platform export: " .. (platform_name or "unknown"))
end

--- Export import result summary
--- @param result table: The import result with statistics
--- @param platform_name string: Name of the platform
function DebugExport.export_import_result(result, platform_name)
  if not DebugExport.is_enabled() then
    log(string.format("[DebugExport] Skipping import result export for '%s': debug mode disabled", tostring(platform_name)))
    return false
  end
  
  local safe_name = string.gsub(platform_name or "unknown", "[^%w_-]", "_")
  local filename = string.format("import_result_%s_%d.json", safe_name, game.tick)
  
  return DebugExport.write_json(filename, result, "Import result: " .. (platform_name or "unknown"))
end

return DebugExport
