local LatchRearm = {}

local FORCE_TO_RESTORE_TICKS = 2
local RESTORE_TO_VERIFY_TICKS = 2
local CLEAR_TICKS = 2
local PATIENCE_TICKS = 1800
local MAX_KEPT_RESULTS = 8

local function forced_parameters(item)
  return {
    conditions = {
      { first_signal = item.captured_outputs[1].signal, comparator = ">=", constant = -2147483648 },
    },
    outputs = item.captured_parameters.outputs,
  }
end

local function clearing_parameters(item)
  return {
    conditions = {
      { first_signal = item.captured_outputs[1].signal, comparator = "<", constant = -2147483648 },
    },
    outputs = item.captured_parameters.outputs,
  }
end

local function signal_key(signal)
  return (signal.type or "item") .. "|" .. tostring(signal.name) .. "|" .. (signal.quality or "normal")
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
    patience_deadline = game.tick + PATIENCE_TICKS,
    items = items,
  }
  log(string.format("[LatchRearm] scheduled %d self-feedback latch(es) on %s for post-activation re-arm",
    #items, tostring(job.platform_name)))
  return #items
end

local function platform_paused(items)
  for _, item in ipairs(items) do
    if item.entity and item.entity.valid then
      local platform = item.entity.surface and item.entity.surface.platform
      return platform ~= nil and platform.valid and platform.paused
    end
  end
  return false
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
  local summary = { rearmed = 0, cleared = 0, failed = 0, details = {} }
  for _, item in ipairs(record.items) do
    local outcome = item.outcome or "unknown"
    summary.details[#summary.details + 1] = {
      entity_id = item.entity_id,
      position = item.position,
      outcome = outcome,
    }
    if outcome == "rearmed" then summary.rearmed = summary.rearmed + 1
    elseif outcome:find("cleared to 0", 1, true) then summary.cleared = summary.cleared + 1
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
  log(string.format("[LatchRearm] %s on %s: rearmed=%d cleared=%d failed=%d (%s)",
    job_key, tostring(record.platform_name), summary.rearmed, summary.cleared, summary.failed, reason))
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
      item.needs_clear = true
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
    if platform_paused(record.items) then
      if game.tick >= (record.patience_deadline or 0) then
        for _, item in ipairs(record.items) do
          item.outcome = item.outcome or "not re-armed: platform stayed paused (gateway park)"
        end
        finalize(job_key, record, "platform never unpaused within patience window")
      end
      return
    end
    local any = write_stage(record.items, forced_parameters, "force")
    if any > 0 then
      record.stage = "restore"
      record.at_tick = game.tick + FORCE_TO_RESTORE_TICKS
    else
      finalize(job_key, record, "no live latch survived to the force stage")
    end
  elseif record.stage == "restore" then
    write_stage(record.items, function(item) return item.captured_parameters end, "restore",
      function(item) return item.entity and item.entity.valid end)
    record.stage = "verify"
    record.at_tick = game.tick + RESTORE_TO_VERIFY_TICKS
  elseif record.stage == "verify" then
    local any_clear = false
    for _, item in ipairs(record.items) do
      verify_item(item)
      any_clear = any_clear or (item.needs_clear == true)
    end
    if any_clear then
      write_stage(record.items, clearing_parameters, "clear",
        function(item) return item.needs_clear and item.entity and item.entity.valid end)
      record.stage = "clear_restore"
      record.at_tick = game.tick + CLEAR_TICKS
    else
      finalize(job_key, record, "completed")
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
        log(string.format("[LatchRearm] stage '%s' for %s THREW: %s — dropping the job "
          .. "(deciders keep whatever parameters the last completed stage wrote)",
          tostring(record.stage), tostring(job_key), tostring(err)))
        storage.latch_rearm_jobs[job_key] = nil
      end
    end
  end
end

return LatchRearm
