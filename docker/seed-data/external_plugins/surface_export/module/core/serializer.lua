local Util = require("modules/surface_export/utils/util")
local EntityScanner = require("modules/surface_export/export_scanners/entity-scanner")
local InventoryScanner = require("modules/surface_export/export_scanners/inventory-scanner")
local FluidRegistry = require("modules/surface_export/export_scanners/fluid-registry")
local TileScanner = require("modules/surface_export/export_scanners/tile_scanner")
local Verification = require("modules/surface_export/validators/verification")
local PlatformSchedule = require("modules/surface_export/utils/platform-schedule")
local VersionCompat = require("modules/surface_export/utils/version-compat")
local ExportCache = require("modules/surface_export/utils/export-cache")

local Serializer = {}

function Serializer.export_platform(platform_index, force_name)
  local resolved_force_name = force_name or "player"
  local force = game.forces[resolved_force_name]
  if not force then
    return nil, string.format("Force '%s' not found", resolved_force_name)
  end
  local platforms = force.platforms
  if not platforms[platform_index] then
    return nil, string.format("Platform index %d not found", platform_index)
  end

  local platform = platforms[platform_index]
  if not platform or not platform.valid then
    return nil, "Platform not valid"
  end

  local surface = platform.surface
  if not surface or not surface.valid then
    return nil, "Platform surface not valid"
  end

  local platform_schedule, schedule_err = PlatformSchedule.capture(platform, platform.hub)
  if not platform_schedule then
    return nil, "Failed to capture platform schedule: " .. tostring(schedule_err)
  end

  log(string.format("[FactorioSurfaceExport] Starting export of platform '%s' (index %d)", platform.name, platform_index))
  game.print(string.format("Exporting platform '%s'...", platform.name))

  game.print("Scanning entities...")
  local fluid_registry = FluidRegistry.new()
  InventoryScanner.fluid_registry = fluid_registry
  local scan_ok, entity_data = pcall(EntityScanner.scan_surface, surface)
  InventoryScanner.fluid_registry = nil
  if not scan_ok then
    return nil, "Entity scan failed: " .. tostring(entity_data)
  end
  log(string.format("[FactorioSurfaceExport] Scanned %d entities", #entity_data))

  game.print("Scanning tiles...")
  local tile_data = TileScanner.scan_surface(surface)
  log(string.format("[FactorioSurfaceExport] Scanned %d tiles", #tile_data))

  game.print("Counting items...")
  local item_counts = Verification.count_all_items(entity_data)
  local total_items = Util.sum_items(item_counts)
  log(string.format("[FactorioSurfaceExport] Counted %d total items across %d types", total_items, table_size(item_counts)))

  game.print("Counting fluids...")
  local fluid_segments = FluidRegistry.list(fluid_registry)
  local fluid_counts = Verification.count_fluid_segments(fluid_segments)
  local total_fluids = Util.sum_fluids(fluid_counts)
  log(string.format("[FactorioSurfaceExport] Counted %.1f total fluid volume across %d types", total_fluids, table_size(fluid_counts)))

  local active_mods = (script and script.active_mods) or (game and game.active_mods) or {}

  local export_data = {
    schema_version = VersionCompat.PAYLOAD_SCHEMA_VERSION,
    factorio_version = active_mods.base or "2.1",
    mod_version = active_mods["FactorioSurfaceExport"] or "1.0.0",
    export_timestamp = game.tick,
    platform = {
      name = platform.name,
      force = platform.force.name,
      index = platform_index,
      surface_index = surface.index,
      schedule = platform_schedule,
      paused = platform.paused
    },
    metadata = {
      total_entity_count = #entity_data,
      total_tile_count = #tile_data,
      total_item_count = total_items,
      total_fluid_volume = total_fluids
    },
    entities = entity_data,
    tiles = tile_data,
    fluid_segments = fluid_segments,
    verification = {
      item_counts = item_counts,
      fluid_counts = fluid_counts
    }
  }

  game.print("Verifying data integrity...")
  log(string.format("[Serializer] Verification data created: item_counts=%d types, fluid_counts=%d types",
    export_data.verification and export_data.verification.item_counts and #(table.keys and table.keys(export_data.verification.item_counts) or {}) or 0,
    export_data.verification and export_data.verification.fluid_counts and #(table.keys and table.keys(export_data.verification.fluid_counts) or {}) or 0))
  local valid, error = Verification.verify_export(export_data)
  if not valid then
    log(string.format("[FactorioSurfaceExport ERROR] Verification failed: %s", error))
    return nil, string.format("Verification failed: %s", error)
  end

  game.print("Serializing to JSON...")
  local success, json_string = pcall(Util.encode_json_compat, export_data)

  if not success then
    log(string.format("[FactorioSurfaceExport ERROR] JSON serialization failed: %s", json_string))
    return nil, string.format("JSON serialization failed: %s", json_string)
  end

  log(string.format("[FactorioSurfaceExport] Export complete: platform %s (%d KB)", platform.name, math.floor(#json_string / 1024)))
  
  if not storage.platform_exports then
    storage.platform_exports = {}
  end
  
  local export_id = string.format("%s_%d", platform.name, game.tick)
  ExportCache.record(export_id, {
    data = export_data,
    json_string = json_string,
    platform_name = platform.name,
    platform_index = platform_index,
    force_name = force_name,
    tick = game.tick,
    stats = {
      entities = #entity_data,
      items = total_items,
      fluids = total_fluids,
      size_kb = math.floor(#json_string / 1024)
    }
  })

  ExportCache.prune_to_configured_cap()

  game.print(string.format("Export complete: %s", export_id))
  game.print(string.format("  Entities: %d", #entity_data))
  game.print(string.format("  Items: %d", total_items))
  game.print(string.format("  Fluids: %.1f", total_fluids))
  game.print(string.format("  Size: %d KB", math.floor(#json_string / 1024)))

  return export_data, export_id
end

return Serializer
