local Util = require("modules/surface_export/utils/util")

local DebugExport = {}

function DebugExport.is_enabled()
  local enabled = storage.surface_export_config and storage.surface_export_config.debug_mode == true
  if not enabled then
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

function DebugExport.write_json(filename, data, description)
  if not DebugExport.is_enabled() then
    return false
  end
  
  local full_filename = "debug_" .. filename
  
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

function DebugExport.write_failure_black_box(filename, data)
  local full_filename = "failure_black_box_" .. filename
  local encode_ok, json_data = pcall(function()
    return Util.encode_json_compat(data)
  end)
  if not encode_ok or type(json_data) ~= "string" then
    log(string.format("[BlackBox] ERROR: encode failed for %s: %s", full_filename, tostring(json_data)))
    return nil
  end
  local write_ok, write_err = Util.write_file_compat(full_filename, json_data, false)
  if not write_ok then
    log(string.format("[BlackBox] ERROR: write failed for %s: %s", full_filename, tostring(write_err)))
    return nil
  end
  log(string.format("[BlackBox] Banked %s (%d bytes)", full_filename, #json_data))
  return full_filename
end

function DebugExport.export_source_platform(platform_data, platform_name)
  if not DebugExport.is_enabled() then
    log(string.format("[DebugExport] Skipping source platform export for '%s': debug mode disabled", tostring(platform_name)))
    return false
  end
  
  local safe_name = string.gsub(platform_name or "unknown", "[^%w_-]", "_")
  local filename = string.format("source_platform_%s_%d.json", safe_name, game.tick)
  
  return DebugExport.write_json(filename, platform_data, "Source platform export: " .. (platform_name or "unknown"))
end

function DebugExport.export_census_pass(verdict, platform_name)
  if not DebugExport.is_enabled() then return false end
  local safe_name = string.gsub(platform_name or "unknown", "[^%w_-]", "_")
  local filename = string.format("census_pass_%s_%d.json", safe_name, game.tick)
  local totals = verdict.totals or {}
  local item_total = 0
  for _, amount in pairs(totals.physical_items or {}) do item_total = item_total + amount end
  local fluid_total = 0
  for _, amount in pairs(totals.physical_fluids_by_name or {}) do fluid_total = fluid_total + amount end
  local summary = {
    ok = verdict.ok,
    mismatch_count = verdict.mismatches and #verdict.mismatches or 0,
    entity_count = totals.entity_count,
    item_total = item_total,
    fluid_total = fluid_total,
    items_exact = totals.items_exact,
    fluids_exact = totals.fluids_exact,
    platform_name = platform_name,
    gate_tick = game.tick,
  }
  return DebugExport.write_json(filename, summary, "Census pass: " .. (platform_name or "unknown"))
end

function DebugExport.export_destination_platform(platform_data, platform_name)
  if not DebugExport.is_enabled() then
    log(string.format("[DebugExport] Skipping destination platform export for '%s': debug mode disabled", tostring(platform_name)))
    return false
  end
  
  local safe_name = string.gsub(platform_name or "unknown", "[^%w_-]", "_")
  local filename = string.format("destination_platform_%s_%d.json", safe_name, game.tick)
  
  return DebugExport.write_json(filename, platform_data, "Destination platform export: " .. (platform_name or "unknown"))
end

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
