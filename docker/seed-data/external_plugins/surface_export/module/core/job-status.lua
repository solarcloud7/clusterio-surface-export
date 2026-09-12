-- Read persisted work cursors; scheduler visits and profiler/log activity are not progress.
local Status = {VERSION = 1}

function Status.snapshot(job)
  local phase
  if job.type == "export" then
    phase = job.entities_complete and (job.completion_stage or "capture") or "entities"
  elseif job.setup_pending then phase = job.decoded_data and "platform preparation" or "decoding"
  elseif not job.tiles_placed then phase = "tiles"
  elseif not job.beacons_placed then phase = "beacons"
  elseif not job.entities_complete then phase = "entities"
  elseif job.phase2_started then phase = job.phase2_stage or "inventories"
  elseif job.pending_beacon_tick then phase = "deferred beacon wait"
  elseif not job.phase1_started then phase = "hub"
  elseif not job.belts_complete then phase = "belts"
  else phase = "state" end
  local section, inventory = job.section_cursor or job.json_cursor or {}, job.inventory_cursor or {}
  local work = {
    entities = job.current_index or 0, tiles = ((job.tile_cursor or {}).index or 1) - 1,
    tilePass = (job.tile_cursor or {}).foundation == false and 2 or 1,
    beacons = (job.beacon_cursor or 1) - 1,
    beltGroups = ((job.belt_batches or {}).cursor or 1) - 1,
    inventoryIndex = (inventory.index or 1) - 1,
    inventoryPass = inventory.disabling_beacons and 3 or (inventory.beacons == false and 2 or 1),
    sectionsDecoded = ((job.section_decoder or {}).next or 1) - 1,
    fieldsEncoded = (section.index or 1) - 1, fieldRecordsEncoded = (section.item or section.array_index or 1) - 1,
    sectionsCompressed = #(job.compressed_sections or {}),
  }
  return phase, work
end

function Status.read(job_id)
  local job = (storage.async_jobs or {})[job_id]
  local result = (storage.async_job_results or {})[job_id]
  local response = {version = Status.VERSION, jobId = job_id,
    epoch = storage.source_recovery_epoch, observedTick = game.tick, state = "unavailable"}
  if job then
    response.phase, response.work = Status.snapshot(job)
    response.operationId = job.operation_id or job.transfer_id
    response.startedTick = job.started_tick
    response.elapsedTicks = job.started_tick and game.tick - job.started_tick
    response.waitUntilTick = job.pending_beacon_tick or (job.setup_cleanup or {}).next_tick
    response.error = (job.completion_interrupted or {}).error or (job.setup_cleanup or {}).error
    response.state = job.setup_cleanup and "cleanup-pending"
      or job.completion_interrupted and "interrupted"
      or (response.waitUntilTick and game.tick < response.waitUntilTick) and "waiting"
      or job.last_step_tick == nil and "queued" or "running"
  elseif result then
    response.state = (result.status == "failed" or (result.validation and result.validation.success == false)) and "failed" or "completed"
    response.operationId = result.operation_id or result.transfer_id
    response.completion = result.completion
    response.error = result.error
  end
  return response
end
return Status
