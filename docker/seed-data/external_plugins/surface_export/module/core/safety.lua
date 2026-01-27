-- FactorioSurfaceExport - Safety
-- Atomic operations and error handling

local Serializer = require("modules/surface_export/core/serializer")
local Deserializer = require("modules/surface_export/core/deserializer")
local Util = require("modules/surface_export/utils/util")

local Safety = {}

--- Atomic export with error handling
--- @param force_name string|nil: Optional force name the platform belongs to
function Safety.atomic_export(platform_index, force_name)
  local success, export_data_or_nil, filename_or_error = pcall(function()
    return Serializer.export_platform(platform_index, force_name)
  end)

  if success then
    -- pcall succeeded, check if Serializer.export_platform succeeded
    if export_data_or_nil then
      -- Export successful
      return export_data_or_nil, filename_or_error
    else
      -- Export failed, filename_or_error contains error message
      local error_msg = filename_or_error or "Unknown error"
      log(string.format("[FactorioSurfaceExport ERROR] Export failed: %s", error_msg))
      return nil, error_msg
    end
  else
    -- pcall failed (exception was thrown)
    local error_msg = export_data_or_nil or "Unknown error"
    log(string.format("[FactorioSurfaceExport ERROR] Export crashed: %s", error_msg))
    return nil, error_msg
  end
end

--- Atomic import with error handling
--- @param filename string: Filename to import from
--- @param surface LuaSurface: Target surface
--- @return boolean, string|nil: success flag and error message if failed
function Safety.atomic_import(filename, surface)
  local success, result, error = pcall(function()
    return Deserializer.import_platform(filename, surface)
  end)

  if success and result then
    return result, error
  else
    -- Log error
    local error_msg = error or result or "Unknown error"
    log(string.format("[FactorioSurfaceExport ERROR] Import failed: %s", error_msg))
    game.print(string.format("Import failed: %s", error_msg))
    return false, error_msg
  end
end

--- Import platform from JSON data string (for Clusterio plugin)
--- @param json_data string: JSON string containing platform export data
--- @param surface LuaSurface: Target surface to import into
--- @return boolean, string|nil: success flag and error message
function Safety.atomic_import_from_data(json_data, surface)
  local success, result = pcall(function()
    local Util = require("modules/surface_export/utils/util")
    -- Parse JSON data
    local platform_data = Util.json_to_table_compat(json_data)
    if not platform_data then
      error("Failed to parse JSON data")
    end
    
    -- Use the existing Deserializer to import
    local Deserializer = require("modules/surface_export/core/deserializer")
    return Deserializer.deserialize_surface(platform_data, surface)
  end)
  
  if not success then
    local error_msg = tostring(result)
    log(string.format("[FactorioSurfaceExport ERROR] Import from data failed: %s", error_msg))
    game.print(string.format("Import failed: %s", error_msg))
    return false, error_msg
  end
  
  if not result then
    local error_msg = "Deserialization returned false"
    log(string.format("[FactorioSurfaceExport ERROR] %s", error_msg))
    game.print(string.format("Import failed: %s", error_msg))
    return false, error_msg
  end
  
  return true, nil
end

--- Create a backup of a surface before import (for rollback)
--- WARNING: This is memory-intensive and should only be used for small surfaces
--- @param surface LuaSurface: Surface to backup
--- @return table: Backup data
function Safety.create_backup(surface)
  -- This is a placeholder - actual implementation would use Serializer
  -- For production, consider external backup solutions
  game.print("Warning: Backup not implemented, import is irreversible!")
  return {}
end

--- Restore a surface from backup
--- @param surface LuaSurface: Surface to restore
--- @param backup table: Backup data
function Safety.restore_backup(surface, backup)
  -- Placeholder for backup restoration
  game.print("Warning: Backup restoration not implemented!")
end

--- Delete a backup
--- @param backup table: Backup to delete
function Safety.delete_backup(backup)
  -- Cleanup backup data
  backup = nil
end

return Safety
