local SignalStability = require("modules/surface_export/utils/signal-stability")

local LatchRearm = {}

local FORCE_TO_RESTORE_TICKS = 2
local RESTORE_TO_VERIFY_TICKS = 2
local CLEAR_TICKS = 2
local MAX_KEPT_RESULTS = 8

LatchRearm.SAMPLE_COUNT = 5
LatchRearm.SAMPLE_GAPS = { 13, 17, 19, 23 }

LatchRearm.POWER_WAIT_TICKS = 1800
LatchRearm.POWER_POLL_TICKS = 60

LatchRearm.LIVE_STATUSES = { working = true }

LatchRearm.UNPOWERED_SAMPLE_OUTCOME = " — unpowered, stability unknown, no clear"
LatchRearm.UNPOWERED_FORCE_OUTCOME = "unpowered — re-arm not evaluated"

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

function LatchRearm.forced_parameters(item)
  local params = {}
  for k, v in pairs(item.captured_parameters) do params[k] = v end
  params.conditions = {
    { first_signal = item.captured_outputs[1].signal, comparator = ">=", constant = -2147483648 },
  }
  return params
end

function LatchRearm.clearing_parameters(item)
  return {
    conditions = {
      { first_signal = item.captured_outputs[1].signal, comparator = "<", constant = -2147483648 },
    },
    outputs = item.captured_parameters.outputs,
  }
end

local signal_key = SignalStability.signal_key

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
      if not has_self_feedback(record) then
        log(string.format("[LatchRearm] decider %s held output at export but has no direct "
          .. "self-feedback loop — not a latch, it re-derives from live inputs; skipped",
          tostring(record.entity_id)))
      elseif entity and entity.valid and captured and captured.outputs then
        items[#items + 1] = {
          entity = entity,
          entity_id = record.entity_id,
          position = record.position,
          captured_parameters = captured,
          captured_outputs = sd.output_signals,
          outcome = nil,
        }
      else
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
    stage = "preflight",
    at_tick = game.tick + 1,
    items = items,
  }
  log(string.format("[LatchRearm] scheduled %d self-feedback latch(es) on %s for post-activation re-arm",
    #items, tostring(job.platform_name)))
  return #items
end

local function write_stage(items, make_params, what, filter)
  local wrote = 0
  for _, item in ipairs(items) do
    local included = filter and filter(item) or (not filter and not item.outcome)
    if included then
      if not (item.entity and item.entity.valid) then
        item.outcome = item.outcome or ("entity invalid before " .. what)
      else
        local ok, err = pcall(function()
          item.entity.get_control_behavior().parameters = make_params(item)
        end)
        if ok then
          wrote = wrote + 1
        else
          item.outcome = item.outcome or string.format("%s write failed: %s", what, tostring(err))
          log(string.format("[LatchRearm] %s failed for latch %s: %s", what,
            tostring(item.entity_id), tostring(err)))
        end
      end
    end
  end
  return wrote
end

local function finalize(job_key, record, reason)
  local summary = { rearmed = 0, cleared = 0, failed = 0, moving = 0, details = {} }
  for _, item in ipairs(record.items) do
    local outcome = item.outcome or "unknown"
    summary.details[#summary.details + 1] = {
      entity_id = item.entity_id,
      position = item.position,
      outcome = outcome,
    }
    if outcome == "rearmed" then summary.rearmed = summary.rearmed + 1
    elseif outcome:find("cleared to 0", 1, true) then summary.cleared = summary.cleared + 1
    elseif outcome:find("register moving", 1, true) then summary.moving = summary.moving + 1
    else summary.failed = summary.failed + 1 end
    if outcome ~= "rearmed" then
      log(string.format("[LatchRearm]   latch %s at (%s,%s): %s", tostring(item.entity_id),
        tostring(item.position and item.position.x), tostring(item.position and item.position.y), outcome))
    end
  end
  summary.platform_name = record.platform_name
  summary.transfer_id = record.transfer_id
  summary.finished_tick = game.tick
  summary.reason = reason

  storage.latch_rearm_results = storage.latch_rearm_results or {}
  storage.latch_rearm_results[job_key] = summary
  local keys = {}
  for k, v in pairs(storage.latch_rearm_results) do keys[#keys + 1] = { k = k, t = v.finished_tick or 0 } end
  if #keys > MAX_KEPT_RESULTS then
    table.sort(keys, function(a, b) return a.t < b.t end)
    for i = 1, #keys - MAX_KEPT_RESULTS do storage.latch_rearm_results[keys[i].k] = nil end
  end

  storage.latch_rearm_jobs[job_key] = nil
  log(string.format("[LatchRearm] %s on %s: rearmed=%d cleared=%d moving=%d failed=%d (%s)",
    job_key, tostring(record.platform_name), summary.rearmed, summary.cleared, summary.moving,
    summary.failed, reason))
end

local function verify_item(item)
  if item.outcome then return end
  if not (item.entity and item.entity.valid) then
    item.outcome = "entity invalid before verify"
    return
  end
  local ok, sigs = pcall(function() return item.entity.get_control_behavior().signals_last_tick end)
  if not ok then
    item.outcome = "verify read failed: " .. tostring(sigs)
    log(string.format("[LatchRearm] verify read failed for latch %s: %s",
      tostring(item.entity_id), tostring(sigs)))
    return
  end
  local now = {}
  for _, s in pairs(sigs or {}) do
    if s.signal and s.signal.name then now[signal_key(s.signal)] = s.count end
  end
  for _, captured in ipairs(item.captured_outputs) do
    local live = now[signal_key(captured.signal)]
    if live ~= captured.count then
      item.mismatch = true
      item.samples = { SignalStability.snapshot(sigs) }
      item.outcome = string.format("mismatch: %s=%s after re-arm (captured %s)",
        tostring(captured.signal.name), tostring(live), tostring(captured.count))
      return
    end
  end
  item.outcome = "rearmed"
end

local function run_stage(job_key, record)
  if record.stage == "preflight" then
    local ok_count = write_stage(record.items, function(item) return item.captured_parameters end,
      "preflight restore")
    for _, item in ipairs(record.items) do
      if item.outcome and item.outcome:find("preflight restore write failed", 1, true) then
        item.outcome = "not re-armed: captured parameters cannot be written on this destination ("
          .. item.outcome .. ")"
      end
    end
    if ok_count == 0 then
      finalize(job_key, record, "no latch accepted its captured parameters")
    else
      record.stage = "force"
      record.at_tick = game.tick + 1
    end
  elseif record.stage == "force" then
    local unpowered = 0
    for _, item in ipairs(record.items) do
      if not item.outcome and item.entity and item.entity.valid
        and not LatchRearm.instrument_live(item.entity) then
        unpowered = unpowered + 1
      end
    end
    if unpowered > 0 then
      record.power_deadline = record.power_deadline or (game.tick + LatchRearm.POWER_WAIT_TICKS)
      if game.tick < record.power_deadline then
        record.at_tick = game.tick + LatchRearm.POWER_POLL_TICKS
        return
      end
      for _, item in ipairs(record.items) do
        if not item.outcome and item.entity and item.entity.valid then
          local live, status_name = LatchRearm.instrument_live(item.entity)
          if not live then
            item.outcome = LatchRearm.UNPOWERED_FORCE_OUTCOME
            log(string.format("[LatchRearm] latch %s never powered within %d ticks (status %s) — "
              .. "captured parameters left in place, no force, no clear",
              tostring(item.entity_id), LatchRearm.POWER_WAIT_TICKS, tostring(status_name)))
          end
        end
      end
    end
    local any = write_stage(record.items, LatchRearm.forced_parameters, "force")
    if any > 0 then
      record.stage = "restore"
      record.at_tick = game.tick + FORCE_TO_RESTORE_TICKS
    else
      local timed_out = 0
      for _, item in ipairs(record.items) do
        if item.outcome == LatchRearm.UNPOWERED_FORCE_OUTCOME then timed_out = timed_out + 1 end
      end
      if timed_out > 0 then
        finalize(job_key, record, string.format(
          "no latch powered up within %d ticks — %d left un-evaluated at captured parameters",
          LatchRearm.POWER_WAIT_TICKS, timed_out))
      else
        finalize(job_key, record, "no live latch survived to the force stage")
      end
    end
  elseif record.stage == "restore" then
    write_stage(record.items, function(item) return item.captured_parameters end, "restore",
      function(item) return item.entity and item.entity.valid end)
    record.stage = "verify"
    record.at_tick = game.tick + RESTORE_TO_VERIFY_TICKS
  elseif record.stage == "verify" then
    local any_mismatch = false
    for _, item in ipairs(record.items) do
      verify_item(item)
      any_mismatch = any_mismatch or (item.mismatch == true)
    end
    if any_mismatch then
      record.stage = "stability_sample"
      record.gap_index = 1
      record.at_tick = game.tick + LatchRearm.SAMPLE_GAPS[1]
    else
      finalize(job_key, record, "completed")
    end
  elseif record.stage == "stability_sample" then
    local pending = false
    for _, item in ipairs(record.items) do
      if item.mismatch and not item.sample_read_failed and not item.instrument_dead
        and item.entity and item.entity.valid then
        local live, status_name = LatchRearm.instrument_live(item.entity)
        if not live then
          item.instrument_dead = true
          item.outcome = (item.outcome or "mismatch") .. LatchRearm.UNPOWERED_SAMPLE_OUTCOME
            .. " (status " .. tostring(status_name) .. ")"
          log(string.format("[LatchRearm] latch %s not evaluating (status %s) — register unreadable, "
            .. "no clear", tostring(item.entity_id), tostring(status_name)))
        else
          local ok, sigs = pcall(function() return item.entity.get_control_behavior().signals_last_tick end)
          if ok then
            item.samples[#item.samples + 1] = SignalStability.snapshot(sigs)
            if #item.samples < LatchRearm.SAMPLE_COUNT then
              pending = true
            end
          else
            item.sample_read_failed = true
            item.outcome = (item.outcome or "mismatch") .. " — sampling read failed: " .. tostring(sigs)
            log(string.format("[LatchRearm] stability sample read failed for latch %s: %s",
              tostring(item.entity_id), tostring(sigs)))
          end
        end
      end
    end
    if pending then
      record.gap_index = math.min((record.gap_index or 1) + 1, #LatchRearm.SAMPLE_GAPS)
      record.at_tick = game.tick + LatchRearm.SAMPLE_GAPS[record.gap_index]
      return
    end
    local any_clear = false
    for _, item in ipairs(record.items) do
      if item.mismatch and not item.sample_read_failed and not item.instrument_dead
        and item.entity and item.entity.valid then
        if SignalStability.should_clear(item.samples, LatchRearm.SAMPLE_COUNT) then
          item.needs_clear = true
          any_clear = true
        else
          item.outcome = (item.outcome or "mismatch") .. " — register moving, not a latch, no clear"
        end
      end
    end
    if any_clear then
      write_stage(record.items, LatchRearm.clearing_parameters, "clear",
        function(item) return item.needs_clear and item.entity and item.entity.valid end)
      record.stage = "clear_restore"
      record.at_tick = game.tick + CLEAR_TICKS
    else
      finalize(job_key, record, "completed — no stable mismatch to clear")
    end
  elseif record.stage == "clear_restore" then
    write_stage(record.items, function(item) return item.captured_parameters end, "clear restore",
      function(item) return item.needs_clear and item.entity and item.entity.valid end)
    record.stage = "clear_verify"
    record.at_tick = game.tick + RESTORE_TO_VERIFY_TICKS
  elseif record.stage == "clear_verify" then
    for _, item in ipairs(record.items) do
      if item.needs_clear and item.entity and item.entity.valid then
        local ok, sigs = pcall(function() return item.entity.get_control_behavior().signals_last_tick end)
        local still_held = nil
        if ok then
          for _, s in pairs(sigs or {}) do
            if s.signal and s.signal.name then
              for _, captured in ipairs(item.captured_outputs) do
                if signal_key(s.signal) == signal_key(captured.signal) then still_held = s.count end
              end
            end
          end
        end
        if not ok then
          item.outcome = (item.outcome or "mismatch") .. " — clear UNVERIFIED (read failed: "
            .. tostring(sigs) .. ")"
        elseif still_held then
          item.outcome = (item.outcome or "mismatch") .. " — clear FAILED (register still holds "
            .. tostring(still_held) .. ")"
        else
          item.outcome = (item.outcome or "mismatch") .. " — cleared to 0 (verified)"
        end
      end
    end
    finalize(job_key, record, "completed with mismatches cleared")
  else
    finalize(job_key, record, "unknown stage '" .. tostring(record.stage) .. "'")
  end
end

function LatchRearm.process_tick()
  if not storage.latch_rearm_jobs then return end
  for job_key, record in pairs(storage.latch_rearm_jobs) do
    if game.tick >= (record.at_tick or 0) then
      local ok, err = pcall(run_stage, job_key, record)
      if not ok then
        log(string.format("[LatchRearm] stage '%s' for %s THREW: %s — restoring captured parameters, "
          .. "then dropping the job",
          tostring(record.stage), tostring(job_key), tostring(err)))
        local restored = 0
        for _, item in ipairs(record.items or {}) do
          if item.entity and item.entity.valid and item.captured_parameters then
            local rok, rerr = pcall(function()
              item.entity.get_control_behavior().parameters = item.captured_parameters
            end)
            if rok then
              restored = restored + 1
            else
              log(string.format("[LatchRearm] post-throw captured restore failed for %s: %s",
                tostring(item.entity_id), tostring(rerr)))
            end
          end
        end
        log(string.format("[LatchRearm] post-throw restore wrote captured parameters to %d decider(s)",
          restored))
        local details = {}
        for _, item in ipairs(record.items or {}) do
          details[#details + 1] = {
            entity_id = item.entity_id,
            position = item.position,
            outcome = item.outcome or ("stage '" .. tostring(record.stage) .. "' threw"),
          }
        end
        storage.latch_rearm_results = storage.latch_rearm_results or {}
        storage.latch_rearm_results[job_key] = {
          rearmed = 0, cleared = 0, moving = 0, failed = #details, details = details,
          platform_name = record.platform_name,
          transfer_id = record.transfer_id,
          finished_tick = game.tick,
          reason = string.format("stage '%s' threw: %s (%d decider(s) restored to captured parameters)",
            tostring(record.stage), tostring(err), restored),
        }
        storage.latch_rearm_jobs[job_key] = nil
      end
    end
  end
end

return LatchRearm
