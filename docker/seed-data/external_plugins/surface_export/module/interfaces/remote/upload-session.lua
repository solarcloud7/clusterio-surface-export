local Sessions = require("modules/surface_export/core/import-session")
local AsyncProcessor = require("modules/surface_export/core/async-processor")
local Json = require("modules/surface_export/utils/json-compat")
local Upload = {}

function Upload.call(action, request_json)
  local ok, response = pcall(function()
    local q = assert(Json.json_to_table_compat(request_json), "Invalid upload request")
    assert(q.version == Sessions.VERSION, "Unsupported upload protocol; deploy matching Node and Lua")
    if action == "initialize" then return Sessions.initialize(q.epoch) end
    if action == "begin" then return Sessions.begin(q) end
    if action == "chunk" then return Sessions.chunk(q.attemptId, q.index, q.data) end
    if action == "commit" then return Sessions.commit(q.attemptId, AsyncProcessor.queue_import) end
    if action == "status" then return Sessions.status(q.attemptId) end
    if action == "abort" then return Sessions.abort(q.attemptId) end
    error("Unknown upload action")
  end)
  if not ok then return {version = Sessions.VERSION, success = false, error = tostring(response)} end
  return response
end

function Upload.jobs(request_json)
  local q = assert(Json.json_to_table_compat(request_json), "Invalid status request")
  assert(q.version == Sessions.VERSION and type(q.jobs) == "table" and #q.jobs <= 100, "Unsupported job status request")
  local statuses = {}
  for _, ref in ipairs(q.jobs) do
    local job_id = ref.jobId
    local attempt
    if not job_id and type(ref.operationId) == "string" then
      for _, record in pairs((storage.import_sessions or {}).records or {}) do
        if record.operation_id == ref.operationId then job_id = record.job_id; attempt = record; break end
      end
    end
    local status = job_id and AsyncProcessor.get_job_status(job_id) or {state = "unavailable"}
    if status.state == "unavailable" and attempt then
      status.phase = "upload " .. attempt.state
      status.error = attempt.error or "Upload receipt retained; job status unavailable"
    end
    -- Never return another operation's job as confirmation of the requested one.
    if ref.operationId and status.operationId and ref.operationId ~= status.operationId then
      status = {state = "unavailable"}
    end
    status.operationId = ref.operationId or status.operationId
    statuses[#statuses + 1] = status
  end
  return {version = Sessions.VERSION, epoch = storage.source_recovery_epoch, observedTick = game.tick, jobs = statuses}
end
return Upload
