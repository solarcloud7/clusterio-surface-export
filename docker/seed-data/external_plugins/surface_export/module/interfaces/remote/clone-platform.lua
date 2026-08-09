local Serializer = require("modules/surface_export/core/serializer")
local AsyncProcessor = require("modules/surface_export/core/async-processor")

local function clone_platform(source_index, dest_name)
  source_index = tonumber(source_index)
  log(string.format("[Clone Platform] Request: source_index=%s, dest='%s'", tostring(source_index), tostring(dest_name)))

  if not source_index then
    log("[Clone Platform] FAILED: source_index (a number) is required")
    return { success = false, error = "source_index (a number) is required" }
  end

  if not dest_name or dest_name == "" then
    log("[Clone Platform] FAILED: dest_name is required")
    return { success = false, error = "dest_name is required" }
  end

  local force = game.forces["player"]
  if not force then
    log("[Clone Platform] FAILED: Player force not found")
    return { success = false, error = "Player force not found" }
  end

  local source_platform = force.platforms[source_index]
  if not source_platform or not source_platform.valid then
    log(string.format("[Clone Platform] FAILED: No valid platform at index %d", source_index))
    return { success = false, error = "No platform at index " .. tostring(source_index) }
  end
  local source_name = source_platform.name

  for _, platform in pairs(force.platforms) do
    if platform.name == dest_name then
      log(string.format("[Clone Platform] FAILED: Destination platform '%s' already exists", dest_name))
      return { success = false, error = "Destination platform '" .. dest_name .. "' already exists" }
    end
  end
  
  local source_surface = source_platform.surface
  if not source_surface then
    log(string.format("[Clone Platform] FAILED: Source platform '%s' has no surface", source_name))
    return { success = false, error = "Source platform has no surface" }
  end
  
  log(string.format("[Clone Platform] Exporting source platform '%s' (index=%d)...", source_name, source_index))
  local export_data, error_msg = Serializer.export_platform(source_index, "player")
  if not export_data then
    log(string.format("[Clone Platform] FAILED: Export failed: %s", error_msg or "unknown"))
    return { success = false, error = "Failed to export source platform: " .. (error_msg or "unknown") }
  end
  
  local entity_count = #(export_data.entities or {})
  local tile_count = #(export_data.tiles or {})
  log(string.format("[Clone Platform] Export complete: %d entities, %d tiles", entity_count, tile_count))
  
  export_data.platform.name = dest_name
  
  log(string.format("[Clone Platform] Queuing import job for '%s' (%d entities)...", dest_name, entity_count))
  local job_id, import_error = AsyncProcessor.queue_import(export_data, dest_name, "player", "clone")
  
  if not job_id then
    log(string.format("[Clone Platform] FAILED: Import queue failed: %s", import_error or "unknown"))
    return { success = false, error = "Failed to start import job: " .. (import_error or "unknown") }
  end
  
  log(string.format("[Clone Platform] SUCCESS: job_id=%s, platform='%s', entities=%d", job_id, dest_name, entity_count))
  
  return {
    success = true,
    job_id = job_id,
    platform_name = dest_name,
    source_platform = source_name,
    entity_count = entity_count,
    message = "Clone job started - use /step-tick to process"
  }
end

return clone_platform
