-- FactorioSurfaceExport - Async Job Processor
-- Handles export/import jobs across multiple ticks to prevent game freezing

local Serializer = require("modules/surface_export/core/serializer")
local Deserializer = require("modules/surface_export/core/deserializer")
local EntityScanner = require("modules/surface_export/export_scanners/entity-scanner")
local EntityHandlers = require("modules/surface_export/export_scanners/entity-handlers")
local InventoryScanner = require("modules/surface_export/export_scanners/inventory-scanner")
local Verification = require("modules/surface_export/validators/verification")
local TransferValidation = require("modules/surface_export/validators/transfer-validation")
local LossAnalysis = require("modules/surface_export/validators/loss-analysis")
local Util = require("modules/surface_export/utils/util")
local GameUtils = require("modules/surface_export/utils/game-utils")
local SurfaceLock = require("modules/surface_export/utils/surface-lock")
local FluidRestoration = require("modules/surface_export/import_phases/fluid_restoration")
local EntityStateRestoration = require("modules/surface_export/import_phases/entity_state_restoration")
local TileRestoration = require("modules/surface_export/import_phases/tile_restoration")
local PlatformHubMapping = require("modules/surface_export/import_phases/platform_hub_mapping")
local EntityCreation = require("modules/surface_export/import_phases/entity_creation")
local BeltRestoration = require("modules/surface_export/import_phases/belt_restoration")
local ActiveStateRestoration = require("modules/surface_export/import_phases/active_state_restoration")
local TileScanner = require("modules/surface_export/export_scanners/tile_scanner")
local DebugExport = require("modules/surface_export/utils/debug-export")
local clusterio_api = require("modules/clusterio/api")

local MAX_IMPORT_SESSIONS = 4
local MAX_SESSION_AGE_TICKS = 3600  -- ~60 seconds at 60 UPS
local MAX_TOTAL_CHUNKS = 256

local AsyncProcessor = {}

-- Configuration storage (set via remote interface)
local config = {
  batch_size = 50,
  max_concurrent_jobs = 3,
  show_progress = true,
  sync_mode = false,  -- If true, process all entities in a single tick (for debugging)
}

--- Initialize storage for async jobs
function AsyncProcessor.init()
  storage.async_jobs = storage.async_jobs or {}
  storage.async_job_id_counter = storage.async_job_id_counter or 0
  storage.async_job_results = storage.async_job_results or {}
  storage.import_sessions = storage.import_sessions or {}
end

--- Set batch size
--- @param value number: Entities to process per tick
function AsyncProcessor.set_batch_size(value)
  config.batch_size = value
end

--- Set sync mode (process all entities in single tick for debugging)
--- @param value boolean: Whether to enable sync mode
function AsyncProcessor.set_sync_mode(value)
  config.sync_mode = value
  if value then
    log("[AsyncProcessor] SYNC MODE ENABLED - all entities will be processed in single tick")
    game.print("[AsyncProcessor] SYNC MODE ENABLED - all entities processed in single tick (debugging)", {1, 1, 0})
  else
    log("[AsyncProcessor] Sync mode disabled - normal async processing")
    game.print("[AsyncProcessor] Sync mode disabled - normal async processing", {0, 1, 0})
  end
end

--- Get sync mode status
function AsyncProcessor.get_sync_mode()
  return config.sync_mode
end

--- Set max concurrent jobs
--- @param value number: Maximum number of jobs to process simultaneously
function AsyncProcessor.set_max_concurrent_jobs(value)
  config.max_concurrent_jobs = value
end

--- Set show progress flag
--- @param value boolean: Whether to show progress messages
function AsyncProcessor.set_show_progress(value)
  config.show_progress = value
end

--- Get batch size
--- @return number: Entities to process per tick
local function get_batch_size()
  if config.sync_mode then
    return 1000000  -- Process all entities in single tick for debugging
  end
  return config.batch_size
end

--- Get max concurrent jobs
--- @return number: Maximum number of jobs to process simultaneously
local function get_max_concurrent_jobs()
  return config.max_concurrent_jobs
end

--- Check if progress messages should be shown
--- @return boolean
local function should_show_progress()
  return config.show_progress
end

local function prune_results(max_entries)
  local keys = {}
  for key in pairs(storage.async_job_results) do
    table.insert(keys, key)
  end
  table.sort(keys)
  while #keys > max_entries do
    local oldest = table.remove(keys, 1)
    storage.async_job_results[oldest] = nil
  end
end

local function calculate_progress(job)
  if not job or not job.total_entities or job.total_entities == 0 then
    return 0
  end
  return math.floor((job.current_index / job.total_entities) * 100)
end

local function prune_import_sessions()
  local sessions = storage.import_sessions
  if not sessions then return end

  local now = game.tick
  local keys = {}
  local pruned_age = 0
  for key, session in pairs(sessions) do
    if (now - (session.started_tick or now)) > MAX_SESSION_AGE_TICKS then
      log(string.format("[Import Session] Pruned session '%s' (age: %d ticks, platform: %s)",
        key, now - (session.started_tick or now), tostring(session.platform_name)))
      sessions[key] = nil
      pruned_age = pruned_age + 1
    else
      table.insert(keys, key)
    end
  end

  -- Keep only newest MAX_IMPORT_SESSIONS by started_tick
  table.sort(keys, function(a, b)
    local sa = sessions[a]
    local sb = sessions[b]
    return (sa and sa.started_tick or 0) < (sb and sb.started_tick or 0)
  end)

  while #keys > MAX_IMPORT_SESSIONS do
    local oldest = table.remove(keys, 1)
    sessions[oldest] = nil
  end
end

--- Sort entities for proper placement order
--- Underground belts, pipes, etc. need special ordering
--- @param entities table: Array of entity data or LuaEntity objects
--- @return table: Sorted array
local function sort_entities_for_placement(entities)
  -- Define placement priority (lower = earlier)
  local function get_priority(entity_or_data)
    -- Handle both LuaEntity (export) and entity_data (import fallback)
    local name = entity_or_data.name or ""
    local type_name = entity_or_data.type or ""
    
    -- 1. Tiles and rails first (foundation)
    if type_name == "straight-rail" or type_name == "curved-rail" then
      return 1
    end
    
    -- 2. Underground belts - entrance before exit
    -- Only access belt_to_ground_type if it's actually an underground belt
    if type_name == "underground-belt" then
      -- Safely access belt_to_ground_type (only exists on underground-belt entities)
      local belt_type = entity_or_data.belt_to_ground_type
      if belt_type == "input" then
        return 2  -- Input/entrance first
      else
        return 3  -- Output/exit second
      end
    end
    
    -- 3. Pipes and underground pipes
    if type_name == "pipe-to-ground" then
      return 4
    end
    
    -- 4. Regular entities
    return 5
  end
  
  -- Create sorted copy
  local sorted = {}
  for _, entity in ipairs(entities) do
    table.insert(sorted, entity)
  end
  
  -- Sort by priority, then by position for deterministic ordering
  table.sort(sorted, function(a, b)
    local priority_a = get_priority(a)
    local priority_b = get_priority(b)
    
    if priority_a ~= priority_b then
      return priority_a < priority_b
    end
    
    -- Same priority - sort by position for consistency
    if a.position and b.position then
      local pos_a = a.position
      local pos_b = b.position
      if pos_a.x ~= pos_b.x then
        return pos_a.x < pos_b.x
      end
      return pos_a.y < pos_b.y
    end
    
    return false
  end)
  
  return sorted
end

--- Queue an export job
--- @param platform_index number
--- @param force_name string
--- @param requester_name string|nil: Player name or "RCON"
--- @param destination_instance_id number|nil: If set, transfer to this instance after export
--- @return string: Job ID
function AsyncProcessor.queue_export(platform_index, force_name, requester_name, destination_instance_id)
  AsyncProcessor.init()
  
  storage.async_job_id_counter = storage.async_job_id_counter + 1
  local job_counter = storage.async_job_id_counter
  
  local force = game.forces[force_name]
  if not force or not force.platforms[platform_index] then
    log(string.format("[Export Queue] FAILED: Platform index %s not found for force '%s'", tostring(platform_index), force_name))
    return nil, "Platform not found"
  end
  
  local platform = force.platforms[platform_index]
  
  -- Sanitize platform name (replace non-alphanumeric with dash)
  local safe_name = platform.name:gsub("[^%w%-]", "-")
  
  -- Generate export_id: counter_platformName
  -- Format: 001_test
  -- (All timing data is in the export payload - ID is just a clean key)
  local job_id = string.format("%03d_%s", job_counter, safe_name)
  
  log(string.format("[Export Queue] job_id=%s, platform_index=%s, force=%s, requester=%s, dest_instance_id=%s (type=%s)",
    job_id, tostring(platform_index), force_name, tostring(requester_name),
    tostring(destination_instance_id), type(destination_instance_id)))
  local surface = platform.surface
  if not surface or not surface.valid then
    return nil, "Platform surface not valid"
  end

  -- CRITICAL: Lock the platform BEFORE scanning to ensure stable item/fluid counts
  -- This completes cargo pods, deactivates machines, and hides surface
  local lock_success, lock_err = SurfaceLock.lock_platform(platform, force)
  if not lock_success then
    -- If already locked by another operation, that's fine - just note it
    if lock_err ~= "Platform already locked" then
      return nil, "Failed to lock platform: " .. (lock_err or "unknown error")
    end
    log(string.format("[Export] Platform %s was already locked, continuing with export", platform.name))
  else
    game.print(string.format("[Export] Locked platform %s for stable export...", platform.name), {1, 0.8, 0})
  end
  
  local entities = surface.find_entities_filtered({})
  
  -- Sort entities for proper placement order (inputs before outputs, etc.)
  -- Do this once on export rather than re-sorting on every import
  entities = sort_entities_for_placement(entities)
  
  -- Scan tiles for platform foundation
  local tiles = TileScanner.scan_surface(surface)
  log(string.format("[Export] Scanned %d tiles and %d entities from platform %s (sorted for placement, locked)", #tiles, #entities, platform.name))
  
  storage.async_jobs[job_id] = {
    type = "export",
    job_id = job_id,
    platform_index = platform_index,
    platform_name = platform.name,
    force_name = force_name,
    requester = requester_name,
    destination_instance_id = destination_instance_id,  -- Transfer destination
    started_tick = game.tick,
    surface = surface,  -- Keep reference for unlock
    
    -- Export state
    entities = entities,
    total_entities = #entities,
    current_index = 0,
    -- Belt entities tracked for deferred atomic scan
    -- Maps serialized entity index → live LuaEntity reference
    belt_entities = {},
    export_data = {
      platform_name = platform.name,
      force_name = force_name,
      tick = game.tick,
      timestamp = Util.format_timestamp(game.tick),
      tiles = tiles,  -- Include platform foundation tiles
      entities = {},
      stats = {
        entity_count = #entities,
        tile_count = #tiles,
        started_tick = game.tick
      }
    }
  }
  
  return job_id
end

--- Begin a chunked import session
--- @param session_id string
--- @param total_chunks number
--- @param platform_name string|nil
--- @param force_name string|nil
--- @return boolean, string|nil
function AsyncProcessor.begin_import_session(session_id, total_chunks, platform_name, force_name)
  AsyncProcessor.init()
  prune_import_sessions()

  log(string.format("[Import Session] begin_import_session: session_id=%s, total_chunks=%s, platform=%s, force=%s",
    tostring(session_id), tostring(total_chunks), tostring(platform_name), tostring(force_name)))

  if not session_id or session_id == "" then
    log("[Import Session] FAILED: session_id required")
    return false, "session_id required"
  end
  if storage.import_sessions[session_id] then
    log(string.format("[Import Session] FAILED: session '%s' already exists", session_id))
    return false, "session already exists"
  end

  if not total_chunks or total_chunks < 1 or total_chunks > MAX_TOTAL_CHUNKS then
    return false, "invalid total_chunks"
  end

  local active = 0
  for _ in pairs(storage.import_sessions) do
    active = active + 1
  end
  if active >= MAX_IMPORT_SESSIONS then
    return false, "too many active sessions"
  end

  storage.import_sessions[session_id] = {
    total_chunks = total_chunks,
    received = {},
    received_count = 0,
    platform_name = platform_name,
    force_name = force_name,
    started_tick = game.tick
  }

  log(string.format("[Import Session] Session '%s' created: expecting %d chunks for platform '%s'",
    session_id, total_chunks, tostring(platform_name)))

  return true, nil
end

--- Enqueue a chunk into a session
--- @param session_id string
--- @param chunk_index number
--- @param chunk_data string
--- @return boolean, string|nil
function AsyncProcessor.enqueue_import_chunk(session_id, chunk_index, chunk_data)
  AsyncProcessor.init()
  prune_import_sessions()

  local session = storage.import_sessions[session_id]
  if not session then
    return false, "session not found"
  end

  if not chunk_index or chunk_index < 1 or chunk_index > session.total_chunks then
    return false, "invalid chunk index"
  end

  if session.received[chunk_index] then
    return false, "chunk already received"
  end

  session.received[chunk_index] = chunk_data or ""
  session.received_count = session.received_count + 1

  -- Log progress for every chunk (sessions are typically small)
  log(string.format("[Import Session] Chunk received: session=%s, chunk=%d/%d, size=%d bytes",
    session_id, session.received_count, session.total_chunks, #(chunk_data or "")))

  return true, nil
end

--- Finalize a session, assemble payload, and queue async import
--- @param session_id string
--- @param checksum string|nil
--- @return string|nil, string|nil: job_id or nil + error
function AsyncProcessor.finalize_import_session(session_id, checksum)
  AsyncProcessor.init()
  prune_import_sessions()

  log(string.format("[Import Session] finalize_import_session: session_id=%s, checksum=%s",
    tostring(session_id), tostring(checksum ~= nil)))

  local session = storage.import_sessions[session_id]
  if not session then
    log(string.format("[Import Session] FAILED: session '%s' not found (may have been pruned)", tostring(session_id)))
    return nil, "session not found"
  end

  if session.received_count ~= session.total_chunks then
    log(string.format("[Import Session] FAILED: session '%s' incomplete - received %d/%d chunks",
      session_id, session.received_count, session.total_chunks))
    return nil, "incomplete session"
  end

  local ordered = {}
  for i = 1, session.total_chunks do
    local chunk = session.received[i]
    if not chunk then
      storage.import_sessions[session_id] = nil
      return nil, "missing chunk " .. i
    end
    table.insert(ordered, chunk)
  end

  local assembled = table.concat(ordered)

  log(string.format("[Import Session] Session '%s' assembled: %d chunks -> %d bytes",
    session_id, session.total_chunks, #assembled))

  if checksum and checksum ~= Util.simple_checksum(assembled) then
    storage.import_sessions[session_id] = nil
    return nil, "checksum mismatch"
  end

  local job_id, err = AsyncProcessor.queue_import(
    assembled,
    session.platform_name,
    session.force_name or "player",
    "RCON"
  )

  storage.import_sessions[session_id] = nil

  if not job_id then
    return nil, err
  end

  return job_id, nil
end

--- Queue an import job from file
--- @param filename string: Filename in script-output/platform_exports/
--- @param new_platform_name string
--- @param force_name string
--- @param requester_name string|nil
--- @return string: Job ID
function AsyncProcessor.queue_import_from_file(filename, new_platform_name, force_name, requester_name)
  -- Read file from script-output/platform_exports/
  local filepath = "platform_exports/" .. filename
  local json_data, err = Util.read_file_compat(filepath)
  
  if not json_data then
    return nil, "Failed to read file '" .. filename .. "': " .. (err or "unknown error")
  end
  
  -- Use existing queue_import logic
  return AsyncProcessor.queue_import(json_data, new_platform_name, force_name, requester_name)
end

--- Queue an import job from JSON string
--- @param json_data string: JSON string of platform data
--- @param new_platform_name string
--- @param force_name string
--- @param requester_name string|nil
--- @return string: Job ID
function AsyncProcessor.queue_import(json_data, new_platform_name, force_name, requester_name)
  AsyncProcessor.init()
  
  storage.async_job_id_counter = storage.async_job_id_counter + 1
  local job_id = "import_" .. storage.async_job_id_counter
  
  log(string.format("[Import Queue] job_id=%s, platform='%s', force=%s, requester=%s, data_type=%s",
    job_id, tostring(new_platform_name), tostring(force_name), tostring(requester_name), type(json_data)))
  if type(json_data) == "string" then
    log(string.format("[Import Queue] JSON string size: %d bytes", #json_data))
  end
  
  -- First, parse if it's a JSON string
  local parsed_data
  if type(json_data) == "string" then
    parsed_data = Util.json_to_table_compat(json_data)
    if not parsed_data then
      return nil, "Failed to parse JSON data"
    end
  else
    -- Already a table
    parsed_data = json_data
  end
  
  -- Now check if the parsed data is compressed
  local platform_data
  if parsed_data.compressed and parsed_data.payload then
    -- Compressed format: decode base64 and inflate
    log(string.format("[Decompression] Decompressing import data (%d bytes compressed)", #parsed_data.payload))
    local decompressed_json = helpers.decode_string(parsed_data.payload)
    if not decompressed_json then
      return nil, "Failed to decompress data"
    end
    log(string.format("[Decompression] Decompressed to %d bytes", #decompressed_json))
    
    -- Parse the decompressed JSON
    platform_data = Util.json_to_table_compat(decompressed_json)
    if not platform_data then
      return nil, "Failed to parse decompressed JSON data"
    end
    -- Debug: Check if verification exists after decompression
    log(string.format("[Import] After decompression: has_verification=%s", tostring(platform_data.verification ~= nil)))
    if platform_data.verification then
      log(string.format("[Import] Verification has item_counts=%s, fluid_counts=%s",
        tostring(platform_data.verification.item_counts ~= nil),
        tostring(platform_data.verification.fluid_counts ~= nil)))
    end
  else
    -- Uncompressed format - data is already the platform data
    platform_data = parsed_data
  end
  
  -- Entities are already sorted during export for proper placement order
  -- No need to re-sort on import
  
  local force = game.forces[force_name] or game.forces.player
  
  -- Handle missing platform name
  local original_name = new_platform_name
  local name_was_missing = false
  if not new_platform_name or new_platform_name == "" then
    name_was_missing = true
    new_platform_name = "Imported Platform"
    game.print("[Import Warning] No platform name provided, assigning default name", {1, 0.5, 0})
  end
  
  -- Check if platform name already exists and find unique name
  local function platform_name_exists(name)
    for _, platform in pairs(force.platforms) do
      if platform.name == name then
        return true
      end
    end
    return false
  end
  
  local final_name = new_platform_name
  if platform_name_exists(new_platform_name) then
    local counter = 1
    while platform_name_exists(string.format("%s #%d", new_platform_name, counter)) do
      counter = counter + 1
    end
    final_name = string.format("%s #%d", new_platform_name, counter)
    game.print(string.format("[Import Warning] Platform '%s' already exists, renamed to '%s'", 
      new_platform_name, final_name), {1, 0.5, 0})
  elseif name_was_missing then
    -- Assign numbered name for missing names
    local counter = 1
    while platform_name_exists(string.format("Imported Platform #%d", counter)) do
      counter = counter + 1
    end
    final_name = string.format("Imported Platform #%d", counter)
    game.print(string.format("[Import Warning] Assigned name: '%s'", final_name), {1, 0.5, 0})
  end
  
  -- Create new platform
  local new_platform = force.create_space_platform({
    name = final_name,
    planet = "nauvis",
    starter_pack = "space-platform-starter-pack"
  })
  
  if not new_platform or not new_platform.valid then
    log(string.format("[Import Queue] FAILED: Could not create platform '%s'", final_name))
    return nil, "Failed to create platform"
  end
  
  log(string.format("[Import Queue] Platform created: '%s' (index=%s)", final_name, tostring(new_platform.index)))
  
  -- Apply starter pack to activate surface immediately
  -- Platform needs starter pack to have a valid surface
  local ok, err = pcall(function()
    new_platform.apply_starter_pack()
  end)
  
  if not ok then
    new_platform.destroy()
    return nil, "Failed to apply starter pack: " .. tostring(err)
  end
  
  -- Validate surface is now accessible
  if not new_platform.surface or not new_platform.surface.valid then
    new_platform.destroy()
    log(string.format("[Import Queue] FAILED: Platform '%s' surface not valid after activation", final_name))
    return nil, "Platform surface not valid after activation"
  end
  
  -- Log what the starter pack placed on the surface
  local starter_entities = new_platform.surface.find_entities_filtered({})
  log(string.format("[Import Queue] Starter pack applied: %d entities on surface (platform '%s')", #starter_entities, final_name))
  for _, ent in ipairs(starter_entities) do
    log(string.format("[Import Queue]   Starter entity: %s at (%.1f, %.1f)", ent.name, ent.position.x, ent.position.y))
  end
  
  -- CRITICAL: For transfers, PAUSE the platform immediately to prevent thruster fuel consumption
  -- This stops the platform from using fuel during the multi-tick import process
  local is_transfer = (platform_data._transferId or parsed_data._transferId) ~= nil
  if is_transfer then
    new_platform.paused = true
    log(string.format("[Import] Platform %s PAUSED to prevent fuel consumption during import", new_platform.name))
  end
  
  -- Calculate item and fluid totals from verification data if available
  local total_items = 0
  local total_fluids = 0
  if platform_data.verification then
    total_items = Util.sum_items(platform_data.verification.item_counts or {})
    total_fluids = Util.sum_fluids(platform_data.verification.fluid_counts or {})
  end
  
  storage.async_jobs[job_id] = {
    type = "import",
    job_id = job_id,
    platform_name = new_platform.name,
    force_name = force_name,
    requester = requester_name,
    started_tick = game.tick,
    
    -- Import state
    platform_data = platform_data,
    target_surface = new_platform.surface,
    tiles_to_place = platform_data.tiles or {},
    tiles_placed = false,
    entities_to_create = platform_data.entities or {},
    total_entities = #(platform_data.entities or {}),
    total_items = total_items,
    total_fluids = math.floor(total_fluids),  -- Fluids can be fractional
    current_index = 0,
    
    -- Entity map for post-processing (circuit connections, etc.)
    entity_map = {},
    
    -- CRITICAL: frozen_states contains original active/disabled states from export
    -- Used to restore entities to their pre-export state in final import step
    frozen_states = platform_data.frozen_states or {},
    
    -- Transfer metadata (if this is a transfer import)
    -- Check both parsed_data (compressed format) and platform_data (decompressed)
    transfer_id = platform_data._transferId or parsed_data._transferId,
    source_instance_id = platform_data._sourceInstanceId or parsed_data._sourceInstanceId,
    
    -- Store platform reference for unpausing after validation
    target_platform = new_platform,
    
    -- ========== PHASE METRICS TRACKING ==========
    -- Track timing and counts for each import phase
    metrics = {
      -- Phase timing (tick numbers)
      tiles_started_tick = nil,
      tiles_completed_tick = nil,
      entities_started_tick = nil,
      entities_completed_tick = nil,
      fluids_started_tick = nil,
      fluids_completed_tick = nil,
      belts_started_tick = nil,
      belts_completed_tick = nil,
      state_started_tick = nil,
      state_completed_tick = nil,
      validation_started_tick = nil,
      validation_completed_tick = nil,
      -- Counts
      tiles_placed = 0,
      entities_created = 0,
      entities_failed = 0,
      fluids_restored = 0,
      belt_items_restored = 0,
      circuits_connected = 0,
    }
  }
  
  log(string.format("[Import Job] Created job %s for platform '%s' (transfer_id=%s, source=%s)", 
    job_id, new_platform.name, 
    tostring(storage.async_jobs[job_id].transfer_id), 
    tostring(storage.async_jobs[job_id].source_instance_id)))
  
  return job_id
end

--- Process one batch of an export job
--- @param job table: Job data
--- @return boolean: true if job complete
local function process_export_batch(job)
  local batch_size = get_batch_size()
  local start_index = job.current_index + 1
  local end_index = math.min(start_index + batch_size - 1, job.total_entities)
  
  -- CRITICAL: Tell entity handlers to skip belt item extraction during async scanning.
  -- Belt items will be captured in a single atomic tick in complete_export_job instead.
  -- This prevents the "rolling snapshot" problem where items move between belts during
  -- multi-tick scanning, causing duplicates or missed items.
  -- Wrapped to ensure flag is always cleared even if an error occurs mid-batch.
  EntityHandlers.skip_belt_items = true
  local batch_ok, batch_err = pcall(function()
    for i = start_index, end_index do
      local entity = job.entities[i]
      if entity and entity.valid then
        local entity_data = EntityScanner.serialize_entity(entity)
        if entity_data then
          table.insert(job.export_data.entities, entity_data)

          -- Track belt entities for deferred atomic item scan
          local category = Util.get_entity_category(entity)
          if GameUtils.BELT_ENTITY_TYPES[category] then
            local serialized_index = #job.export_data.entities
            job.belt_entities[serialized_index] = entity  -- Live LuaEntity reference
          end
        end
      end
    end
  end)
  EntityHandlers.skip_belt_items = false
  if not batch_ok then error(batch_err) end
  
  job.current_index = end_index
  
  -- Show progress every 10 batches
  if should_show_progress() and end_index % (batch_size * 10) == 0 then
    local progress = math.floor((end_index / job.total_entities) * 100)
    game.print(string.format("[Export %s] Progress: %d%% (%d/%d entities)",
      job.platform_name, progress, end_index, job.total_entities))
  end
  
  return job.current_index >= job.total_entities
end

--- Process one batch of an import job
--- @param job table: Job data
--- @return boolean: true if job complete
local function process_import_batch(job)
  -- Validate surface is still valid
  if not job.target_surface or not job.target_surface.valid then
    log(string.format("[Import Batch] ABORT: Target surface became invalid for job %s (platform '%s')",
      job.job_id, job.platform_name))
    game.print("[Import Error] Target surface became invalid", {1, 0, 0})
    return true  -- Abort job
  end
  
  -- Initialize metrics if needed
  job.metrics = job.metrics or {}
  
  -- Phase 1: Tile Restoration (track timing)
  if not job.tiles_placed then
    if not job.metrics.tiles_started_tick then
      job.metrics.tiles_started_tick = game.tick
    end
  end
  TileRestoration.process(job)
  if job.tiles_placed and not job.metrics.tiles_completed_tick then
    job.metrics.tiles_completed_tick = game.tick
    job.metrics.tiles_placed = #(job.tiles_to_place or {})
  end
  
  -- Phase 2: Platform Hub Mapping
  PlatformHubMapping.process(job)
  
  -- Phase 3: Entity Creation Batch (track timing)
  if not job.metrics.entities_started_tick and job.tiles_placed then
    job.metrics.entities_started_tick = game.tick
  end
  local complete = EntityCreation.process_batch(job, get_batch_size, should_show_progress)
  if complete and not job.metrics.entities_completed_tick then
    job.metrics.entities_completed_tick = game.tick
    -- Count created entities from entity_map
    local created = 0
    for _ in pairs(job.entity_map or {}) do created = created + 1 end
    job.metrics.entities_created = created
    job.metrics.entities_failed = job.total_entities - created
  end
  
  return complete
end

--- Handle a pending file write request for a completed export
--- @param export_id string: The export ID to check for pending writes
local function handle_pending_file_write(export_id)
  if not storage.pending_file_writes or not storage.pending_file_writes[export_id] then
    return
  end

  local file_request = storage.pending_file_writes[export_id]
  local filename = file_request.filename

  -- Generate filename if not provided
  if not filename then
    filename = string.format("platform_exports/%s.json", export_id)
  end

  -- Write export to file
  local export_entry = storage.platform_exports[export_id]
  if export_entry then
    local json_string = export_entry.json_string
    if not json_string then
      json_string = Util.encode_json_compat(export_entry)
    end

    if json_string then
      game.write_file(filename, json_string, false)
      log(string.format("[Export] File written: %s (%d bytes)", filename, #json_string))
      game.print(string.format("[Export] File written: script-output/%s", filename), {0, 1, 0})
    else
      log(string.format("[Export ERROR] Failed to serialize export for file write: %s", export_id))
    end
  end

  storage.pending_file_writes[export_id] = nil
end

--- Complete an export job
--- @param job table: Job data
local function complete_export_job(job)
  -- The job_id already contains the full export_id (platformName_tick_export_N)
  -- generated at queue time to prevent race conditions
  local export_id = job.job_id
  
  -- Store completed export with compression
  storage.platform_exports = storage.platform_exports or {}
  
  -- ========================================
  -- ATOMIC BELT ITEM SCAN (single-tick pass)
  -- ========================================
  -- During async entity scanning, belt item extraction was SKIPPED to prevent the
  -- "rolling snapshot" problem: belts can't be deactivated, so items keep moving
  -- between belts during multi-tick scanning, causing duplicates or missed items.
  -- 
  -- Now that all entity structure is serialized, we do a single-tick scan of ALL
  -- belt entities' transport lines. This gives an atomic, consistent snapshot of
  -- belt item positions — no items can move between belts within a single tick.
  -- ========================================
  local belt_scan_count = 0
  local belt_item_total = 0
  for serialized_index, live_entity in pairs(job.belt_entities or {}) do
    if live_entity and live_entity.valid then
      local belt_items = InventoryScanner.extract_belt_items(live_entity)
      local entity_data = job.export_data.entities[serialized_index]
      if entity_data and entity_data.specific_data then
        entity_data.specific_data.items = belt_items
        belt_scan_count = belt_scan_count + 1
        -- Count items for logging
        for _, line_data in ipairs(belt_items) do
          for _ in ipairs(line_data.items or {}) do
            belt_item_total = belt_item_total + 1
          end
        end
      end
    else
      log(string.format("[Belt Scan] WARNING: Belt entity at index %d became invalid before atomic scan",
        serialized_index))
    end
  end
  log(string.format("[Export] Atomic belt scan: %d belts scanned, %d item stacks captured (single tick)",
    belt_scan_count, belt_item_total))
  -- ========================================
  
  -- CRITICAL: Generate verification data from SERIALIZED entity data
  -- Now includes the atomically-scanned belt items, so verification counts
  -- exactly match what will be restored on import (no rolling snapshot drift).
  local item_counts = Verification.count_all_items(job.export_data.entities)
  local fluid_counts = Verification.count_all_fluids(job.export_data.entities)
  log(string.format("[Export] Generated verification from serialized entity data (%d item types, %d fluid types)",
    table_size(item_counts), table_size(fluid_counts)))
  job.export_data.verification = {
    item_counts = item_counts,
    fluid_counts = fluid_counts
  }
  
  -- CRITICAL: Include frozen_states for restoring original active states on import
  -- The frozen_states map contains the ORIGINAL state of each entity BEFORE freezing.
  -- This allows import to restore entities to their pre-export active/disabled state.
  local lock_data = storage.locked_platforms and storage.locked_platforms[job.platform_name]
  if lock_data and lock_data.frozen_states then
    job.export_data.frozen_states = lock_data.frozen_states
    log(string.format("[Export] Including frozen_states for %d entities", 
      lock_data.frozen_count or 0))
  end
  
  -- Debug: Check if verification exists before compression
  log(string.format("[Export] Before compression: has_verification=%s", tostring(job.export_data.verification ~= nil)))
  if job.export_data.verification then
    log(string.format("[Export] Verification has item_counts=%s, fluid_counts=%s",
      tostring(job.export_data.verification.item_counts ~= nil),
      tostring(job.export_data.verification.fluid_counts ~= nil)))
  end
  
  -- Convert to JSON and compress using helpers.encode_string (deflate + base64)
  local json_string = Util.encode_json_compat(job.export_data)
  local compressed = helpers.encode_string(json_string)
  
  if compressed then
    -- Store compressed data with metadata
    -- CRITICAL: Include verification as top-level field (not compressed) for transfer validation
    storage.platform_exports[export_id] = {
      compressed = true,
      compression = "deflate",
      payload = compressed,
      -- Preserve metadata for list_exports
      platform_name = job.export_data.platform_name,
      tick = job.export_data.tick,
      timestamp = job.export_data.timestamp,
      stats = job.export_data.stats,
      -- CRITICAL: Verification data must be accessible without decompression for transfers
      verification = job.export_data.verification
    }
    log(string.format("[Compression] Export %s: %d bytes → %d bytes (%.1f%% reduction)",
      export_id, #json_string, #compressed, (1 - #compressed / #json_string) * 100))
    log(string.format("[Export] Stored verification: item_counts=%s, fluid_counts=%s",
      tostring(job.export_data.verification and job.export_data.verification.item_counts ~= nil),
      tostring(job.export_data.verification and job.export_data.verification.fluid_counts ~= nil)))
  else
    -- Fallback to uncompressed if compression fails (verification already in export_data)
    storage.platform_exports[export_id] = job.export_data
    log(string.format("[Compression Warning] Failed to compress export %s, storing uncompressed", export_id))
  end
  
  -- Calculate duration
  local duration_ticks = game.tick - job.started_tick
  local duration_seconds = duration_ticks / 60
  
  -- Debug export: Write source platform data for comparison
  if job.destination_instance_id then
    -- This is a transfer export - save for comparison
    DebugExport.export_source_platform(job.export_data, job.platform_name)
  end
  
  -- Notify completion
  local message = string.format(
    "[Export Complete] %s (%d entities in %.1fs) - ID: %s",
    job.platform_name, job.total_entities, duration_seconds, export_id
  )
  game.print(message, {0, 1, 0})
  log(message)
  
  -- Notify requester if via RCON
  if job.requester == "RCON" then
    rcon.print(string.format("EXPORT_COMPLETE:%s", export_id))
  end
  
  -- Send export completion notification to Clusterio plugin via IPC
  -- Note: Don't send full data - it's too large for IPC. Plugin will retrieve it via remote interface.
  if clusterio_api and clusterio_api.send_json then
    local ipc_data = {
      export_id = export_id,
      platform_name = job.platform_name,
      platform_index = job.platform_index,
      entity_count = job.total_entities,
      duration_ticks = duration_ticks,
      duration_seconds = duration_seconds,
      destination_instance_id = job.destination_instance_id  -- For auto-transfer
    }
    
    if job.destination_instance_id then
      log(string.format("[IPC] Sending export notification: %s (%d entities) → transfer to instance %d", 
        export_id, job.total_entities, job.destination_instance_id))
    else
      log(string.format("[IPC] Sending export notification: %s (%d entities)", export_id, job.total_entities))
    end
    local send_success, send_err = pcall(function()
      clusterio_api.send_json("surface_export_complete", ipc_data)
    end)
    
    if send_success then
      log("[IPC] Export notification sent successfully")
    else
      log(string.format("[IPC ERROR] Failed to send notification: %s", tostring(send_err)))
    end
  else
    log("[WARN] clusterio_api not available, export notification not sent to plugin")
  end
  
  storage.async_job_results[job.job_id] = {
    status = "complete",
    complete = true,
    type = "export",
    job_id = job.job_id,
    platform_name = job.platform_name,
    total_entities = job.total_entities,
    duration_ticks = duration_ticks,
    duration_seconds = duration_seconds,
    progress = 100,
    requester = job.requester
  }
  prune_results(25)
  
  -- Handle pending file write if requested
  handle_pending_file_write(export_id)
  
  -- Unlock platform if this is NOT a transfer (transfers will delete the platform anyway)
  if not job.destination_instance_id then
    local unlock_success = SurfaceLock.unlock_platform(job.platform_name)
    if unlock_success then
      game.print(string.format("[Export] Platform %s unlocked - machines reactivated", job.platform_name), {0, 1, 0})
    end
  else
    log(string.format("[Export] Skipping unlock for transfer - platform %s will be deleted", job.platform_name))
  end
  
  -- Cleanup
  storage.async_jobs[job.job_id] = nil
end

--- Complete an import job
--- @param job table: Job data
local function complete_import_job(job)
  local duration_ticks = game.tick - job.started_tick
  local duration_seconds = duration_ticks / 60
  
  -- Initialize metrics if missing
  job.metrics = job.metrics or {}

  -- ========================================
  -- POST-PROCESSING: Restore fluids, belts, connections, control behavior, filters
  -- These must be done AFTER all entities are created
  -- ========================================
  log("[Import] Starting post-processing (hub inventories, fluids, belts, control behavior, filters, connections)...")
  
  local entity_map = job.entity_map or {}
  local entities_to_create = job.entities_to_create or {}
  
  -- Step 0: Restore hub inventories (DEFERRED from platform_hub_mapping)
  -- The hub's inventory size scales with cargo bays, which are now placed.
  PlatformHubMapping.restore_hub_inventories(job)
  
  -- Step 0a: Fluid restoration DEFERRED until after entity activation
  -- Factorio 2.0 fluid segment system: frozen entities are detached from fluid segments.
  -- Writing fluid to a frozen entity writes to a "ghost buffer" that gets wiped when
  -- the entity is unfrozen and joins a live segment. Must inject fluid AFTER activation.
  job.metrics.fluids_deferred = true
  log("[Import] Fluid restoration deferred until after entity activation (frozen entity ghost buffer fix)")
  
  -- Step 0b: Restore belt items synchronously
  -- CRITICAL: Belts are always active and cannot be deactivated.
  -- Must restore all belt items in a single tick to prevent partial restoration
  job.metrics.belts_started_tick = game.tick
  local belts_result = BeltRestoration.restore(entities_to_create, entity_map)
  job.metrics.belts_completed_tick = game.tick
  job.metrics.belt_items_restored = belts_result and belts_result.items_restored or 0
  
  -- Steps 1-5: Restore localized entity state (Control Behavior, Filters, Connections)
  job.metrics.state_started_tick = game.tick
  local state_result = EntityStateRestoration.restore_all(entities_to_create, entity_map)
  job.metrics.state_completed_tick = game.tick
  job.metrics.circuits_connected = state_result and state_result.circuits_connected or 0
  
  -- FINAL STEP: Restore original active/disabled states
  -- For non-transfer imports: activate immediately (no validation step)
  -- For transfers: DEFER activation until AFTER validation passes
  --   This prevents machines from processing resources between activation and validation
  local frozen_states = job.frozen_states or {}
  if job.transfer_id then
    log("[Import] Deferring active state restoration until after validation (transfer mode)")
  else
    ActiveStateRestoration.restore(entities_to_create, entity_map, frozen_states)
    -- Non-transfer: restore fluids after activation (same ghost buffer fix)
    job.metrics.fluids_started_tick = game.tick
    local fluids_result = FluidRestoration.restore(entities_to_create, entity_map)
    job.metrics.fluids_completed_tick = game.tick
    job.metrics.fluids_restored = fluids_result and fluids_result.count or 0
  end
  
  log("[Import] Post-processing complete")
  -- ========================================

  local message = string.format(
    "[Import Complete] %s (%d entities in %.1fs)",
    job.platform_name, job.total_entities, duration_seconds
  )
  game.print(message, {0, 1, 0})
  log(message)

  if job.requester == "RCON" then
    rcon.print(string.format("IMPORT_COMPLETE:%s", job.platform_name))
  end

  -- Perform validation if this is a transfer (has verification data and transfer ID)
  job.metrics.validation_started_tick = game.tick
  
  local validation_result = nil
  local is_transfer = job.transfer_id ~= nil
  local has_platform_data = job.platform_data ~= nil
  local has_verification = has_platform_data and job.platform_data.verification ~= nil
  
  if is_transfer and has_verification then
    -- NOTE: For transfers, entities are imported in deactivated state (active=false)
    -- so we don't need to freeze again. Just validate and then activate on success.
    
    -- TransferValidation is required at top of file
    local success, result = TransferValidation.validate_import(
      job.target_surface,
      job.platform_data.verification,
      { skip_fluid_validation = true }  -- Fluids are deferred to post-activation
    )

    validation_result = result
    TransferValidation.store_validation_result(job.platform_name, result)
    
    -- Debug export: Write validation result for analysis
    DebugExport.export_import_result({
      platform_name = job.platform_name,
      transfer_id = job.transfer_id,
      validation_success = success,
      validation_result = result,
      total_entities = job.total_entities,
      duration_seconds = duration_seconds
    }, job.platform_name)

    -- Debug export: Always write destination platform data when debug_mode is enabled
    -- This allows comparing source vs destination regardless of validation pass/fail
    if job.transfer_id and job.target_surface and job.target_surface.valid then
      local debug_success, debug_err = pcall(function()
        if DebugExport.is_enabled() then
          local scanned_entities = EntityScanner.scan_surface(job.target_surface)
          local destination_data = {
            platform_name = job.platform_name,
            tick = game.tick,
            entities = scanned_entities,
            entity_count = #scanned_entities
          }
          DebugExport.export_destination_platform(destination_data, job.platform_name)
        else
          log("[DebugExport] Skipping destination platform export: debug_mode is not enabled")
        end
      end)
      if not debug_success then
        log(string.format("[DebugExport] ERROR: Failed to export destination platform: %s", tostring(debug_err)))
      end
    else
      log(string.format("[DebugExport] Skipping destination platform export: transfer_id=%s, surface_valid=%s",
        tostring(job.transfer_id), tostring(job.target_surface and job.target_surface.valid)))
    end

    if not success then
      game.print(string.format(
        "[Transfer Validation Failed] %s",
        result.mismatchDetails or "Unknown error"
      ), {1, 0, 0})
      -- Leave platform paused and entities deactivated on validation failure so user can investigate
      log("[Validation] Platform left paused and deactivated due to validation failure")
    else
      -- Validation passed — auto-unpause platform and activate all entities
      -- Use ActiveStateRestoration to restore original active states (not blanket activate_all)
      if job.target_platform and job.target_platform.valid then
        job.target_platform.paused = false
        log(string.format("[Validation] Platform %s UNPAUSED after successful validation", job.platform_name))
      end
      ActiveStateRestoration.restore(job.entities_to_create or {}, job.entity_map or {}, job.frozen_states or {})
      
      -- POST-ACTIVATION FLUID RESTORATION
      -- Entities are now unfrozen and active, connected to live fluid segments.
      -- Fluid injected now will persist correctly instead of being wiped.
      job.metrics.fluids_started_tick = game.tick
      local fluids_result = FluidRestoration.restore(entities_to_create, entity_map)
      job.metrics.fluids_completed_tick = game.tick
      job.metrics.fluids_restored = fluids_result and fluids_result.count or 0
      log(string.format("[Import] Post-activation fluid restoration: %d fluids restored", 
        job.metrics.fluids_restored))
      
      game.print(string.format("[Validation] ✓ Validation passed - entities activated on platform %s!", 
        job.platform_name), {0, 1, 0})
      
      -- ========================================
      -- POST-ACTIVATION LOSS ANALYSIS
      -- Run AFTER active state restoration so inserter held items and
      -- fluid equilibrium are measured accurately.
      -- Updates validation_result so the transaction log gets correct numbers.
      -- ========================================
      if result.totalExpectedItems then
        LossAnalysis.run(job.target_surface, entities_to_create, result)

        -- Re-store updated validation result
        validation_result = result
        TransferValidation.store_validation_result(job.platform_name, result)
      end
      -- ========================================
    end
  end
  
  -- Mark validation complete
  job.metrics.validation_completed_tick = game.tick

  storage.async_job_results[job.job_id] = {
    status = "complete",
    complete = true,
    type = "import",
    job_id = job.job_id,
    platform_name = job.platform_name,
    total_entities = job.total_entities,
    duration_ticks = duration_ticks,
    duration_seconds = duration_seconds,
    progress = 100,
    requester = job.requester,
    validation = validation_result,
    metrics = job.metrics
  }

  if clusterio_api and clusterio_api.send_json then
    local ipc_data = {
      job_id = job.job_id,
      platform_name = job.platform_name,
      entity_count = job.total_entities,
      duration_ticks = duration_ticks,
      -- Include detailed phase metrics
      metrics = {
        -- Timing in ticks (can convert to ms on JS side: ticks / 60 * 1000)
        tiles_ticks = (job.metrics.tiles_completed_tick or 0) - (job.metrics.tiles_started_tick or 0),
        entities_ticks = (job.metrics.entities_completed_tick or job.metrics.entities_started_tick or 0) - (job.metrics.entities_started_tick or 0),
        fluids_ticks = (job.metrics.fluids_completed_tick or 0) - (job.metrics.fluids_started_tick or 0),
        belts_ticks = (job.metrics.belts_completed_tick or 0) - (job.metrics.belts_started_tick or 0),
        state_ticks = (job.metrics.state_completed_tick or 0) - (job.metrics.state_started_tick or 0),
        validation_ticks = (job.metrics.validation_completed_tick or 0) - (job.metrics.validation_started_tick or 0),
        total_ticks = duration_ticks,
        -- Counts
        tiles_placed = job.metrics.tiles_placed or 0,
        entities_created = job.metrics.entities_created or 0,
        entities_failed = job.metrics.entities_failed or 0,
        fluids_restored = job.metrics.fluids_restored or 0,
        belt_items_restored = job.metrics.belt_items_restored or 0,
        circuits_connected = job.metrics.circuits_connected or 0,
        -- Totals from source data
        total_items = job.total_items or 0,
        total_fluids = job.total_fluids or 0,
      }
    }

    -- Include transfer metadata if available
    if job.transfer_id then
      ipc_data.transfer_id = job.transfer_id
      ipc_data.source_instance_id = job.source_instance_id
      
      -- Include validation result for transfers
      if validation_result then
        ipc_data.validation = validation_result
      end
      
      log(string.format("[IPC] Import complete with transfer metadata: transfer_id=%s, source=%s", 
        job.transfer_id, tostring(job.source_instance_id)))
    end

    clusterio_api.send_json("surface_export_import_complete", ipc_data)
  end

  prune_results(25)

  storage.async_jobs[job.job_id] = nil
end

--- Process all active async jobs (called on_tick)
function AsyncProcessor.process_tick()
  if not storage.async_jobs then return end
  prune_import_sessions()
  
  -- Get max concurrent jobs setting
  local max_concurrent = get_max_concurrent_jobs()
  
  -- Collect jobs and sort by priority (started_tick - older jobs first)
  local job_list = {}
  for job_id, job in pairs(storage.async_jobs) do
    table.insert(job_list, {id = job_id, job = job, started = job.started_tick or 0})
  end
  table.sort(job_list, function(a, b) return a.started < b.started end)
  
  -- Periodic progress logging (every 60 ticks = ~1 second)
  if #job_list > 0 and game.tick % 60 == 0 then
    for _, entry in ipairs(job_list) do
      local job = entry.job
      local elapsed = game.tick - (job.started_tick or game.tick)
      log(string.format("[Process Tick] job=%s, type=%s, platform='%s', progress=%d/%d (%d%%), elapsed=%d ticks (%.1fs)",
        entry.id, job.type, job.platform_name or "?",
        job.current_index or 0, job.total_entities or 0,
        calculate_progress(job),
        elapsed, elapsed / 60))
    end
  end
  
  -- Process only up to max_concurrent jobs per tick
  local processed = 0
  for _, entry in ipairs(job_list) do
    if processed >= max_concurrent then
      break  -- Hit concurrent limit, remaining jobs wait until next tick
    end
    
    local job = entry.job
    local complete = false
    
    if job.type == "export" then
      complete = process_export_batch(job)
      if complete then
        complete_export_job(job)
      end
    elseif job.type == "import" then
      complete = process_import_batch(job)
      if complete then
        complete_import_job(job)
      end
    end
    
    processed = processed + 1
  end
end

--- Get status of all active jobs
--- @return table: Array of job status info
function AsyncProcessor.get_active_jobs()
  AsyncProcessor.init()
  
  local jobs = {}
  for job_id, job in pairs(storage.async_jobs) do
    table.insert(jobs, {
      job_id = job_id,
      type = job.type,
      platform_name = job.platform_name,
      progress = calculate_progress(job),
      entities_processed = job.current_index,
      total_entities = job.total_entities,
      elapsed_ticks = game.tick - job.started_tick
    })
  end
  
  return jobs
end

--- Get status for a specific job
--- @param job_id string
--- @return table|nil, string|nil
function AsyncProcessor.get_job_status(job_id)
  AsyncProcessor.init()

  if storage.async_jobs[job_id] then
    local job = storage.async_jobs[job_id]
    return {
      status = "active",
      complete = false,
      type = job.type,
      job_id = job_id,
      platform_name = job.platform_name,
      progress = calculate_progress(job),
      entities_processed = job.current_index,
      total_entities = job.total_entities,
      elapsed_ticks = game.tick - job.started_tick
    }
  end

  if storage.async_job_results[job_id] then
    return storage.async_job_results[job_id]
  end

  return nil, "Job not found"
end

--- Activate a platform surface (exported for use by commands)
--- @param surface LuaSurface: The platform surface
--- @return number: Number of entities activated
function AsyncProcessor.activate_platform(surface)
  return SurfaceLock.activate_all(surface)
end

return AsyncProcessor
