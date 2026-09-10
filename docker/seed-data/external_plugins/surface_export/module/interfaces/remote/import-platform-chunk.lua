local Timing = require("modules/surface_export/utils/operation-timing")
local AsyncProcessor = require("modules/surface_export/core/async-processor")

local function import_platform_chunk(platform_name, chunk_data, chunk_num, total_chunks, force_name, operation_id)
  force_name = force_name or "player"
  if operation_id ~= nil and type(operation_id) ~= "string" then return "ERROR:Invalid operation identity" end
  if type(chunk_data) ~= "string" or type(total_chunks) ~= "number" or total_chunks < 1
    or total_chunks % 1 ~= 0 or total_chunks == math.huge or type(chunk_num) ~= "number"
    or chunk_num % 1 ~= 0 or chunk_num < 1 or chunk_num > total_chunks then
    return "ERROR:Invalid chunk range"
  end
  
  if not storage.chunked_imports then
    storage.chunked_imports = {}
  end
  
  -- Names are not operation identities: concurrent sources can use the same name.
  -- Retain the legacy key only for callers without an operation ID.
  local session_key = operation_id and operation_id ~= "" and ("operation:" .. operation_id)
    or (platform_name .. "_" .. force_name)
  if not storage.chunked_imports[session_key] then
    storage.chunked_imports[session_key] = {
      platform_name = platform_name,
      force_name = force_name,
      total_chunks = total_chunks,
      chunks = {},
      started_tick = game.tick,
      timing_id = "chunks_" .. session_key .. "_" .. game.tick
    }
  end
  
  local session = storage.chunked_imports[session_key]
  if session.total_chunks ~= total_chunks or session.platform_name ~= platform_name or session.force_name ~= force_name then
    return "ERROR:Chunk metadata changed within the operation"
  end
  if session.chunks[chunk_num] and session.chunks[chunk_num] ~= chunk_data then
    return "ERROR:Conflicting duplicate chunk"
  end
  Timing.begin(session.timing_id, "destination-lua", operation_id ~= "" and operation_id or nil)
  Timing.start(session.timing_id, "chunk_delivery", "inclusive")
  session.chunks[chunk_num] = chunk_data
  session.last_activity = game.tick
  
  local received = 0
  for i = 1, total_chunks do
    if session.chunks[i] then
      received = received + 1
    end
  end
  
  if received < total_chunks then
    return string.format("CHUNK_OK:%d/%d", received, total_chunks)
  end
  
  local json_parts = {}
  for i = 1, total_chunks do
    table.insert(json_parts, session.chunks[i])
  end
  local complete_json = Timing.scope(session.timing_id, "chunk_assembly", table.concat, json_parts, "")
  Timing.stop(session.timing_id, "chunk_delivery")
  Timing.finish(session.timing_id, "completed")
  
  storage.chunked_imports[session_key] = nil
  
  local job_id, err = AsyncProcessor.queue_import(
    complete_json,
    platform_name,
    force_name,
    "RCON_CHUNKED",
    { delivery_started_tick = session.started_tick, delivery_completed_tick = game.tick, operation_id = operation_id ~= "" and operation_id or nil }
  )
  
  if not job_id then
    return "ERROR:" .. (err or "Failed to queue import")
  end
  
  log(string.format("[FactorioSurfaceExport] Queued chunked import for platform '%s' (%d chunks, %d KB)",
    platform_name, total_chunks, #complete_json / 1024))
  
  return "JOB_QUEUED:" .. job_id
end

return import_platform_chunk
