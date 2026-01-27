-- FactorioSurfaceExport - Clone Platform Remote Interface
-- Creates a copy of an existing platform with a new name for testing
-- Uses the export/import system to clone platforms on the same instance

local Serializer = require("modules/surface_export/core/serializer")
local AsyncProcessor = require("modules/surface_export/core/async-processor")

--- Clone a platform to a new platform with a different name
--- This uses our export/import system to make a true copy
--- NOTE: This is an ASYNC operation - call start_import_job then step ticks
--- @param source_name string The name of the platform to clone
--- @param dest_name string The name for the new cloned platform
--- @return table Result with success status and job_id for async import
local function clone_platform(source_name, dest_name)
  if not source_name or source_name == "" then
    return { success = false, error = "source_name is required" }
  end
  
  if not dest_name or dest_name == "" then
    return { success = false, error = "dest_name is required" }
  end
  
  -- Find the source platform
  local force = game.forces["player"]
  if not force then
    return { success = false, error = "Player force not found" }
  end
  
  local source_platform = nil
  local source_index = nil
  for idx, platform in pairs(force.platforms) do
    if platform.name == source_name then
      source_platform = platform
      source_index = idx
      break
    end
  end
  
  if not source_platform then
    return { success = false, error = "Source platform '" .. source_name .. "' not found" }
  end
  
  -- Check if dest platform already exists
  for _, platform in pairs(force.platforms) do
    if platform.name == dest_name then
      return { success = false, error = "Destination platform '" .. dest_name .. "' already exists" }
    end
  end
  
  -- Get source surface
  local source_surface = source_platform.surface
  if not source_surface then
    return { success = false, error = "Source platform has no surface" }
  end
  
  -- Step 1: Export the source platform using Serializer
  local export_data, error_msg = Serializer.export_platform(source_index, "player")
  if not export_data then
    return { success = false, error = "Failed to export source platform: " .. (error_msg or "unknown") }
  end
  
  -- Override the platform name for the clone
  export_data.platform.name = dest_name
  
  -- Step 2: Start async import job (creates platform with starter pack, then imports entities)
  -- queue_import takes: json_data (table or string), new_platform_name, force_name, requester_name
  local job_id, import_error = AsyncProcessor.queue_import(export_data, dest_name, "player", "clone")
  
  if not job_id then
    return { success = false, error = "Failed to start import job: " .. (import_error or "unknown") }
  end
  
  return {
    success = true,
    job_id = job_id,
    platform_name = dest_name,
    source_platform = source_name,
    entity_count = #(export_data.entities or {}),
    message = "Clone job started - use /step-tick to process"
  }
end

return clone_platform
