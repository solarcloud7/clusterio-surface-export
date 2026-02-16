-- FactorioSurfaceExport - Serializer
-- Main export logic - orchestrates platform serialization

local Util = require("modules/surface_export/utils/util")
local EntityScanner = require("modules/surface_export/export_scanners/entity-scanner")
local TileScanner = require("modules/surface_export/export_scanners/tile_scanner")
local Verification = require("modules/surface_export/validators/verification")

local Serializer = {}

--- LEGACY: Synchronous export. Debug/testing use only (/export-sync-mode).
--- The production path is async: AsyncProcessor.queue_export().
--- Known limitations: rolling snapshot for belts (Pitfall #16), no deferred belt scan.
--- @param platform_index number: Index of the platform to export (1-based)
--- @param force_name string|nil: Optional force name the platform belongs to
--- @return table|nil, string: Export data and filename on success, nil and error message on failure
--- @deprecated Use AsyncProcessor.queue_export() for production exports
function Serializer.export_platform(platform_index, force_name)
  -- Step 1: Validate platform exists
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

  -- Step 2: Get surface
  local surface = platform.surface
  if not surface or not surface.valid then
    return nil, "Platform surface not valid"
  end

  log(string.format("[FactorioSurfaceExport] Starting export of platform '%s' (index %d)", platform.name, platform_index))
  game.print(string.format("Exporting platform '%s'...", platform.name))

  -- Step 3: Scan all entities
  game.print("Scanning entities...")
  local entity_data = EntityScanner.scan_surface(surface)
  log(string.format("[FactorioSurfaceExport] Scanned %d entities", #entity_data))

  -- Step 3.5: Scan all tiles
  game.print("Scanning tiles...")
  local tile_data = TileScanner.scan_surface(surface)
  log(string.format("[FactorioSurfaceExport] Scanned %d tiles", #tile_data))

  -- Step 4: Count items for verification
  game.print("Counting items...")
  local item_counts = Verification.count_all_items(entity_data)
  local total_items = Util.sum_items(item_counts)
  log(string.format("[FactorioSurfaceExport] Counted %d total items across %d types", total_items, table_size(item_counts)))

  -- Step 5: Count fluids
  game.print("Counting fluids...")
  local fluid_counts = Verification.count_all_fluids(entity_data)
  local total_fluids = Util.sum_fluids(fluid_counts)
  log(string.format("[FactorioSurfaceExport] Counted %.1f total fluid volume across %d types", total_fluids, table_size(fluid_counts)))

  -- Step 6: Build export structure
  local active_mods = (script and script.active_mods) or (game and game.active_mods) or {}

  local export_data = {
    schema_version = "1.0.0",
    factorio_version = active_mods.base or "2.0",
    mod_version = active_mods["FactorioSurfaceExport"] or "1.0.0",
    export_timestamp = game.tick,
    platform = {
      name = platform.name,
      force = platform.force.name,
      index = platform_index,
      surface_index = surface.index,
      -- Extract platform settings
      schedule = platform.schedule,  -- Platform travel schedule (stations, wait conditions, interrupts)
      paused = platform.paused  -- Thrust mode (automatic vs paused)
    },
    metadata = {
      total_entity_count = #entity_data,
      total_tile_count = #tile_data,
      total_item_count = total_items,
      total_fluid_volume = total_fluids
    },
    entities = entity_data,
    tiles = tile_data,
    verification = {
      item_counts = item_counts,
      fluid_counts = fluid_counts
    }
  }

  -- Step 7: Verify internal consistency
  game.print("Verifying data integrity...")
  log(string.format("[Serializer] Verification data created: item_counts=%d types, fluid_counts=%d types",
    export_data.verification and export_data.verification.item_counts and #(table.keys and table.keys(export_data.verification.item_counts) or {}) or 0,
    export_data.verification and export_data.verification.fluid_counts and #(table.keys and table.keys(export_data.verification.fluid_counts) or {}) or 0))
  local valid, error = Verification.verify_export(export_data)
  if not valid then
    log(string.format("[FactorioSurfaceExport ERROR] Verification failed: %s", error))
    return nil, string.format("Verification failed: %s", error)
  end

  -- Step 8: Serialize to JSON
  game.print("Serializing to JSON...")
  local success, json_string = pcall(Util.encode_json_compat, export_data)

  if not success then
    log(string.format("[FactorioSurfaceExport ERROR] JSON serialization failed: %s", json_string))
    return nil, string.format("JSON serialization failed: %s", json_string)
  end

  -- Step 9: Store export data for Clusterio transmission
  log(string.format("[FactorioSurfaceExport] Export complete: platform %s (%d KB)", platform.name, math.floor(#json_string / 1024)))
  
  -- Store export in global for retrieval by Clusterio plugin
  if not storage.platform_exports then
    storage.platform_exports = {}
  end
  
  local export_id = string.format("%s_%d", platform.name, game.tick)
  storage.platform_exports[export_id] = {
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
  }
  
  game.print(string.format("Export complete: %s", export_id))
  game.print(string.format("  Entities: %d", #entity_data))
  game.print(string.format("  Items: %d", total_items))
  game.print(string.format("  Fluids: %.1f", total_fluids))
  game.print(string.format("  Size: %d KB", math.floor(#json_string / 1024)))

  return export_data, export_id
end

--- Export multiple platforms at once
--- @param platform_indices table: Array of platform indices
--- @param force_name string|nil: Optional force name the platforms belong to
--- @return table: Array of results {success, filename/error}
function Serializer.export_platforms_batch(platform_indices, force_name)
  local results = {}

  for _, idx in ipairs(platform_indices) do
    local data, filename_or_error = Serializer.export_platform(idx, force_name)
    table.insert(results, {
      platform_index = idx,
      success = data ~= nil,
      result = filename_or_error
    })
  end

  return results
end

--- LEGACY: Synchronous export preview. Calls EntityScanner.scan_surface() which
--- will freeze the game on large platforms. Debug use only.
--- @param platform_index number: Platform index
--- @param force_name string|nil: Optional force name the platform belongs to
--- @return table|nil: Statistics or nil if invalid
--- @deprecated Performs full synchronous scan; use async export for production
function Serializer.get_export_preview(platform_index, force_name)
  local resolved_force_name = force_name or "player"
  local force = game.forces[resolved_force_name]
  if not force then
    return nil
  end

  local platforms = force.platforms
  if not platforms or not platforms[platform_index] then
    return nil
  end

  local platform = platforms[platform_index]
  local surface = platform.surface

  if not surface or not surface.valid then
    return nil
  end

  local entities = surface.find_entities_filtered({})
  local entity_data = EntityScanner.scan_surface(surface)
  local item_counts = Verification.count_all_items(entity_data)
  local fluid_counts = Verification.count_all_fluids(entity_data)

  return {
    platform_name = platform.name,
    entity_count = #entities,
    item_count = Util.sum_items(item_counts),
    fluid_volume = Util.sum_fluids(fluid_counts),
    estimated_size_kb = math.floor((#entity_data * 500) / 1024)  -- Rough estimate
  }
end

return Serializer
