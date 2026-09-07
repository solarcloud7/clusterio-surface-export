local SignalStability = require("modules/surface_export/utils/signal-stability")

local LatchRearm = {}

local SEED_EVALUATION_TICKS = 2
local RESTORE_TO_VERIFY_TICKS = 2
local MAX_KEPT_RESULTS = 8


local RULE_RESTORE_RETRY_TICKS = 60

LatchRearm.LIVE_STATUSES = { working = true }

function LatchRearm.status_is_live(status_name)
  return LatchRearm.LIVE_STATUSES[status_name] == true
end

local status_names = nil

function LatchRearm.status_name(entity)
  if not status_names then
    status_names = {}
    for name, id in pairs(defines.entity_status) do status_names[id] = name end
  end
  local ok, status = pcall(function() return entity.status end)
  if not ok then return nil end
  return status_names[status]
end

function LatchRearm.instrument_live(entity)
  local name = LatchRearm.status_name(entity)
  return LatchRearm.status_is_live(name), name
end

-- Temporary explicit outputs seed the read-only register through engine evaluation.
-- Never copy input counts here: the imported feedback wire initially carries zero.
function LatchRearm.forced_parameters(item)
  local params = {}
  for k, v in pairs(item.captured_parameters) do params[k] = v end
  params.conditions = {
    { first_signal = item.captured_outputs[1].signal, comparator = ">=", constant = -2147483648 },
  }
  params.outputs = {}
  for _, signal in ipairs(item.captured_outputs) do
    params.outputs[#params.outputs + 1] = {
      signal = signal.signal, copy_count_from_input = false, constant = signal.count,
    }
  end
  params.else_outputs = {}
  return params
end

function LatchRearm.register_matches(item, signals)
  return SignalStability.registers_equal(
    SignalStability.snapshot(item.captured_outputs), SignalStability.snapshot(signals))
end

local COMBINATOR_OUTPUTS = {}
local COMBINATOR_INPUTS = {}
local connector_sets_built = false

local function connector_sets()
  if not connector_sets_built then
    connector_sets_built = true
    local wc = defines.wire_connector_id
    local out_red, out_green = wc.combinator_output_red, wc.combinator_output_green
    local in_red, in_green = wc.combinator_input_red, wc.combinator_input_green
    if out_red and out_green and in_red and in_green then
      COMBINATOR_OUTPUTS[out_red] = true
      COMBINATOR_OUTPUTS[out_green] = true
      COMBINATOR_INPUTS[in_red] = true
      COMBINATOR_INPUTS[in_green] = true
    else
      log("[LatchRearm] combinator wire-connector defines missing on this engine — latch "
        .. "detection DISABLED (version drift; extend utils/version-compat and re-certify)")
    end
  end
  return COMBINATOR_OUTPUTS, COMBINATOR_INPUTS
end

local function has_self_feedback(record)
  local outs, ins = connector_sets()
  for _, conn in ipairs(record.circuit_connections or {}) do
    if conn.target_entity_id == record.entity_id
      and ((outs[conn.source_circuit_id] and ins[conn.target_circuit_id])
        or (ins[conn.source_circuit_id] and outs[conn.target_circuit_id])) then
      return true
    end
  end
  return false
end

function LatchRearm.schedule(job)
  local items = {}
  for _, record in ipairs(job.entities_to_create or {}) do
    local sd = record.specific_data
    if record.type == "decider-combinator" and sd and sd.output_signals and #sd.output_signals > 0 then
      local captured = (record.control_behavior and record.control_behavior.parameters) or sd.parameters
      local entity = record.entity_id and job.entity_map and job.entity_map[record.entity_id]
      if has_self_feedback(record) and entity and entity.valid and captured and captured.outputs then
        items[#items + 1] = {
          entity = entity,
          entity_id = record.entity_id,
          position = record.position,
          captured_parameters = captured,
          captured_outputs = sd.output_signals,
          outcome = nil,
        }
      elseif has_self_feedback(record) then
        log(string.format("[LatchRearm] latch %s at (%s,%s) cannot be scheduled "
          .. "(entity=%s, captured parameters=%s)", tostring(record.entity_id),
          tostring(record.position and record.position.x), tostring(record.position and record.position.y),
          tostring(entity and entity.valid), tostring(captured ~= nil)))
      end
    end
  end
  if #items == 0 then return 0 end

  storage.latch_rearm_jobs = storage.latch_rearm_jobs or {}
  storage.latch_rearm_jobs[job.job_id or ("latch_" .. game.tick)] = {
    platform_name = job.platform_name,
    transfer_id = job.transfer_id,
    version = 2,
    stage = "preflight",
    scheduled_tick = game.tick,
    at_tick = game.tick + 1,
    items = items,
  }
  return #items
end

-- Prevent another export from capturing temporary seed parameters.
function LatchRearm.pending_on_surface(surface_index)
  for _, record in pairs(storage.latch_rearm_jobs or {}) do
    for _, item in ipairs(record.items or {}) do
      if item.entity and item.entity.valid and item.entity.surface.index == surface_index then return true end
    end
  end
  return false
end

local function write_parameters(item, parameters, label)
  local ok, err = pcall(function()
    assert(item.entity and item.entity.valid, "entity invalid")
    item.entity.get_control_behavior().parameters = parameters
  end)
  if not ok then
    -- A later restore failure must not be hidden by an earlier mismatch.
    item.outcome = label .. " write failed: " .. tostring(err)
    item.failed = true
    if item.last_write_error ~= item.outcome then
      log("[LatchRearm] " .. tostring(item.entity_id) .. ": " .. item.outcome)
      item.last_write_error = item.outcome
    end
  end
  return ok
end

local function read_register(item)
  local ok, signals = pcall(function()
    assert(item.entity and item.entity.valid, "entity invalid")
    return item.entity.get_control_behavior().signals_last_tick
  end)
  if not ok then
    item.failed = true
    item.outcome = (item.outcome and (item.outcome .. "; ") or "") .. "register read failed: " .. tostring(signals)
    return nil, false
  end
  return signals, true
end

local function finalize(job_key, record, reason)
  local summary = { rearmed = 0, resumed = 0, cleared = 0, moving = 0, failed = 0, details = {} }
  for _, item in ipairs(record.items) do
    local outcome = item.outcome or "restoration incomplete"
    if not item.failed and outcome == "rearmed" then summary.rearmed = summary.rearmed + 1
    elseif not item.failed and outcome == "seed verified; original rules resumed" then summary.resumed = summary.resumed + 1
    else
      summary.failed = summary.failed + 1
      if item.last_write_error ~= outcome then
        log(string.format("[LatchRearm] restoration failed for %s on %s: %s",
          tostring(item.entity_id), tostring(record.platform_name), outcome))
      end
    end
    summary.details[#summary.details + 1] = {
      entity_id = item.entity_id, position = item.position, outcome = outcome,
      seed_verified = item.seed_verified == true, parameters_restored = item.parameters_restored == true,
      first_seed_status = item.first_seed_status, seed_tick = item.seed_tick,
    }
  end
  summary.platform_name = record.platform_name
  summary.transfer_id = record.transfer_id
  summary.finished_tick = game.tick
  summary.scheduled_tick = record.scheduled_tick
  summary.first_seed_tick = record.first_seed_tick
  summary.reason = reason
  storage.latch_rearm_results = storage.latch_rearm_results or {}
  storage.latch_rearm_results[job_key] = summary
  local keys = {}
  for k, v in pairs(storage.latch_rearm_results) do keys[#keys + 1] = { k = k, t = v.finished_tick or 0 } end
  table.sort(keys, function(a, b) return a.t < b.t end)
  for i = 1, #keys - MAX_KEPT_RESULTS do storage.latch_rearm_results[keys[i].k] = nil end
  storage.latch_rearm_jobs[job_key] = nil
end

local function restore_parameters(record)
  local all_restored = true
  for _, item in ipairs(record.items) do
    if not item.parameters_restored then
      if not (item.entity and item.entity.valid) then
        item.failed = true
        item.outcome = "entity removed before original-rule restoration"
        -- No surviving entity can retain the temporary parameters.
        item.parameters_restored = false
      else
        item.parameters_restored = write_parameters(item, item.captured_parameters, "restore")
        all_restored = all_restored and item.parameters_restored
      end
    end
  end
  return all_restored
end

local function run_stage(job_key, record)
  if record.version ~= 2 then
    -- Saved jobs from the removed sampling/clearing algorithm must restore their rules.
    for _, item in ipairs(record.items) do
      item.failed = true
      item.outcome = "interrupted by restoration upgrade"
      item.parameters_restored = false
    end
    record.version = 2
    record.stage = "restore"
  end
  if record.stage == "preflight" then
    for _, item in ipairs(record.items) do
      write_parameters(item, item.captured_parameters, "preflight restore")
    end
    record.stage = "seed"
    record.at_tick = game.tick + 1
  elseif record.stage == "seed" then
    record.first_seed_tick = record.first_seed_tick or game.tick
    for _, item in ipairs(record.items) do
      if not item.failed then
        local live, status = LatchRearm.instrument_live(item.entity)
        item.first_seed_status = status
        if not live then
          item.failed = true
          item.outcome = "decider not evaluating at restoration: " .. tostring(status or "unknown")
        else
          item.seed_written = write_parameters(item, LatchRearm.forced_parameters(item), "seed")
          if item.seed_written then item.seed_tick = game.tick end
        end
      end
    end
    record.stage = "seed_verify"
    record.at_tick = game.tick + SEED_EVALUATION_TICKS
  elseif record.stage == "seed_verify" then
    for _, item in ipairs(record.items) do
      if not item.failed and item.seed_written then
        local signals, ok = read_register(item)
        item.seed_verified = ok and LatchRearm.instrument_live(item.entity)
          and LatchRearm.register_matches(item, signals)
        if not item.seed_verified and not item.failed then
          item.failed = true
          item.outcome = "seed register did not match captured signals"
        end
      end
    end
    record.stage = "restore"
    record.at_tick = game.tick
    run_stage(job_key, record)
  elseif record.stage == "restore" then
    if not restore_parameters(record) then
      -- Retain the guard and retry original rules. Never abandon temporary parameters.
      record.restore_attempts = (record.restore_attempts or 0) + 1
      if record.restore_attempts == 1 then
        log("[LatchRearm] original-rule restoration failed on " .. tostring(record.platform_name)
          .. "; retaining export guard and retrying")
      end
      record.at_tick = game.tick + RULE_RESTORE_RETRY_TICKS
      return
    end
    record.stage = "verify"
    record.at_tick = game.tick + RESTORE_TO_VERIFY_TICKS
  elseif record.stage == "verify" then
    for _, item in ipairs(record.items) do
      if not item.failed and item.seed_verified then
        local signals, ok = read_register(item)
        if ok then
          item.outcome = LatchRearm.register_matches(item, signals) and "rearmed"
            or "seed verified; original rules resumed"
        end
      end
    end
    finalize(job_key, record, "completed")
  else
    error("unknown restoration stage: " .. tostring(record.stage))
  end
end

function LatchRearm.process_tick()
  for job_key, record in pairs(storage.latch_rearm_jobs or {}) do
    if game.tick >= (record.at_tick or 0) then
      local ok, err = pcall(run_stage, job_key, record)
      if not ok then
        log("[LatchRearm] " .. tostring(record.stage) .. " failed: " .. tostring(err))
        for _, item in ipairs(record.items or {}) do
          item.failed = true
          item.outcome = "restoration interrupted: " .. tostring(err)
          item.parameters_restored = false
        end
        record.stage = "restore"
        record.at_tick = game.tick + 1
      end
    end
  end
end

return LatchRearm
