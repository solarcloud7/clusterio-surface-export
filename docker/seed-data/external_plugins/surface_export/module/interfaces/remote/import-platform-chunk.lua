-- Remote Interface: import_platform_chunk
-- Simple chunked import (like inventory_sync pattern)

local AsyncProcessor = require("modules/surface_export/core/async-processor")

--- Simple chunked import (like inventory_sync pattern)
--- Receives chunks of JSON data and processes when complete
--- @param platform_name string: Name for the new platform
--- @param chunk_data string: JSON chunk data
--- @param chunk_num number: Current chunk number (1-based)
--- @param total_chunks number: Total number of chunks
--- @param force_name string (optional): Force name (defaults to 'player')
--- @return string: Status message
local function import_platform_chunk(platform_name, chunk_data, chunk_num, total_chunks, force_name)
  force_name = force_name or "player"
  
  -- Initialize storage for chunked imports
  if not storage.chunked_imports then
    storage.chunked_imports = {}
  end
  
  -- Create or get import session
  local session_key = platform_name .. "_" .. force_name
  if not storage.chunked_imports[session_key] then
    storage.chunked_imports[session_key] = {
      platform_name = platform_name,
      force_name = force_name,
      total_chunks = total_chunks,
      chunks = {},
      started_tick = game.tick
    }
  end
  
  local session = storage.chunked_imports[session_key]
  session.chunks[chunk_num] = chunk_data
  session.last_activity = game.tick
  
  -- Check if we have all chunks
  local received = 0
  for i = 1, total_chunks do
    if session.chunks[i] then
      received = received + 1
    end
  end
  
  if received < total_chunks then
    return string.format("CHUNK_OK:%d/%d", received, total_chunks)
  end
  
  -- All chunks received - concatenate and process
  local json_parts = {}
  for i = 1, total_chunks do
    table.insert(json_parts, session.chunks[i])
  end
  local complete_json = table.concat(json_parts, "")
  
  -- Clean up session
  storage.chunked_imports[session_key] = nil
  
  -- Queue the import job
  local job_id, err = AsyncProcessor.queue_import(
    complete_json,
    platform_name,
    force_name,
    "RCON_CHUNKED"
  )
  
  if not job_id then
    return "ERROR:" .. (err or "Failed to queue import")
  end
  
  log(string.format("[FactorioSurfaceExport] Queued chunked import for platform '%s' (%d chunks, %d KB)",
    platform_name, total_chunks, #complete_json / 1024))
  
  return "JOB_QUEUED:" .. job_id
end

return import_platform_chunk
