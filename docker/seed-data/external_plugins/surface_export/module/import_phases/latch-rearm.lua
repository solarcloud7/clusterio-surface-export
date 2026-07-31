-- Latch Re-arm (post-activation, non-gating)
--
-- THE GAP THIS CLOSES. A decider combinator's OUTPUT REGISTER is not script-writable
-- (circuit-latch-rearm R1, [empirical, 2.1.11]), so no serializer can restore it: a transferred
-- SR latch reads its own 0 back through the feedback wire and arrives stable at 0. The register
-- CAN be re-derived by temporarily rewriting the decider's CONDITION (which is writable) to one
-- that is always true, letting the combinator evaluate for a tick, then restoring the captured
-- condition — the latch then holds itself (R3). This needs at least one UNPAUSED tick, so it runs
-- POST-ACTIVATION as a deferred multi-tick pass. That is lawful because circuit signals are not
-- part of the exact gate (items + fluids); nothing here can touch gate fields.
--
-- HONESTY CONTRACT (caveat b of R3): forcing a condition true emits whatever the OUTPUTS say — an
-- output with copy_count_from_input=false emits its constant (1 by default), so a source register
-- holding some other count may not be reproduced, and the forced tick can pulse whatever the
-- output network drives. This pass does not predict any of that: it VERIFIES physically after the
-- restore (signals_last_tick vs the captured register) and reports match/mismatch per decider in
-- storage.latch_rearm_results and the log. A mismatch is reported, never silently absorbed.
--
-- CRASH/INTERRUPT SAFETY. The pass is a storage-driven stage machine (force -> restore -> verify)
-- serviced from AsyncProcessor.process_tick. The restore source is the CAPTURED parameters from
-- the payload (never a readback of the entity), so if a save/load lands between force and restore,
-- the persisted record resumes and the restore still happens — a forced condition can outlive the
-- pass only if the instance never ticks again. Every stage is pcall-wrapped per entity (an
-- uncaught throw in on_tick kills the headless server); every job reaches a terminal state.
--
-- PAUSED PLATFORMS (gateway park): combinators do not evaluate while the platform is paused
-- (disabled_by_script does nothing to them — R2 — only the pause stops them). The pass waits up
-- to PATIENCE_TICKS for an unpause, then terminates with an honest "not re-armed" outcome; a
-- gateway-parked platform resumed later keeps its deciders un-rearmed (recorded limitation).

local LatchRearm = {}

local FORCE_TO_RESTORE_TICKS = 2   -- >=1 evaluated tick between force and restore (R3 used many)
local RESTORE_TO_VERIFY_TICKS = 2  -- let the restored condition re-evaluate before measuring
local PATIENCE_TICKS = 1800        -- 30 s for a paused platform to unpause before giving up
local MAX_KEPT_RESULTS = 8

--- Always-true condition: any signal count is >= -2^31. Anchored on the decider's own first
--- captured OUTPUT signal so no foreign signal is introduced into the network.
local function forced_parameters(item)
  return {
    conditions = {
      { first_signal = item.captured_outputs[1].signal, comparator = ">=", constant = -2147483648 },
    },
    outputs = item.captured_parameters.outputs,
  }
end

--- Schedule a re-arm pass for every decider in this import whose CAPTURED output register was
--- non-zero. Called once from the validation-success branch, after activation. Returns the number
--- of deciders scheduled (0 = nothing to do, no job record created).
function LatchRearm.schedule(job)
  local items = {}
  for _, record in ipairs(job.entities_to_create or {}) do
    local sd = record.specific_data
    if record.type == "decider-combinator" and sd and sd.output_signals and #sd.output_signals > 0 then
      local entity = record.entity_id and job.entity_map and job.entity_map[record.entity_id]
      if entity and entity.valid and sd.parameters and sd.parameters.outputs then
        items[#items + 1] = {
          entity = entity,
          entity_id = record.entity_id,
          position = record.position,
          captured_parameters = sd.parameters,
          captured_outputs = sd.output_signals,
          outcome = nil,
        }
      else
        log(string.format("[LatchRearm] decider %s at (%s,%s) held output at export but cannot be "
          .. "scheduled (entity=%s, captured parameters=%s)", tostring(record.entity_id),
          tostring(record.position and record.position.x), tostring(record.position and record.position.y),
          tostring(entity and entity.valid), tostring(sd.parameters ~= nil)))
      end
    end
  end
  if #items == 0 then return 0 end

  storage.latch_rearm_jobs = storage.latch_rearm_jobs or {}
  storage.latch_rearm_jobs[job.job_id or ("latch_" .. game.tick)] = {
    platform_name = job.platform_name,
    transfer_id = job.transfer_id,
    stage = "force",
    at_tick = game.tick + 1,
    patience_deadline = game.tick + PATIENCE_TICKS,
    items = items,
  }
  log(string.format("[LatchRearm] scheduled %d decider(s) on %s for post-activation re-arm",
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

--- Write `params` to every still-valid item; record a per-item outcome on failure. Returns true
--- if at least one write succeeded (a job with zero live entities terminates immediately).
--- `even_failed` re-includes items that already carry an outcome — the restore stage uses it so
--- the captured config is re-asserted on every valid entity regardless of earlier failures
--- (idempotent, and the guarantee that a forced condition cannot leak past this pass).
local function write_all(items, make_params, what, even_failed)
  local any = false
  for _, item in ipairs(items) do
    if item.outcome and not even_failed then
      -- already terminally failed in an earlier stage; leave the recorded outcome
    elseif not (item.entity and item.entity.valid) then
      item.outcome = item.outcome or ("entity invalid before " .. what)
    else
      local ok, err = pcall(function()
        item.entity.get_control_behavior().parameters = make_params(item)
      end)
      if ok then
        any = true
      else
        item.outcome = item.outcome or string.format("%s write failed: %s", what, tostring(err))
        log(string.format("[LatchRearm] %s failed for decider %s: %s", what,
          tostring(item.entity_id), tostring(err)))
      end
    end
  end
  return any
end

local function finalize(job_key, record, reason)
  local summary = { rearmed = 0, mismatched = 0, failed = 0, details = {} }
  for _, item in ipairs(record.items) do
    summary.details[#summary.details + 1] = {
      entity_id = item.entity_id,
      position = item.position,
      outcome = item.outcome or "unknown",
    }
    if item.outcome == "rearmed" then summary.rearmed = summary.rearmed + 1
    elseif item.outcome and item.outcome:find("^mismatch") then summary.mismatched = summary.mismatched + 1
    else summary.failed = summary.failed + 1 end
  end
  summary.platform_name = record.platform_name
  summary.transfer_id = record.transfer_id
  summary.finished_tick = game.tick
  summary.reason = reason

  storage.latch_rearm_results = storage.latch_rearm_results or {}
  storage.latch_rearm_results[job_key] = summary
  -- Bounded history: drop the oldest beyond MAX_KEPT_RESULTS (no unbounded storage growth).
  local keys = {}
  for k, v in pairs(storage.latch_rearm_results) do keys[#keys + 1] = { k = k, t = v.finished_tick or 0 } end
  if #keys > MAX_KEPT_RESULTS then
    table.sort(keys, function(a, b) return a.t < b.t end)
    for i = 1, #keys - MAX_KEPT_RESULTS do storage.latch_rearm_results[keys[i].k] = nil end
  end

  storage.latch_rearm_jobs[job_key] = nil
  log(string.format("[LatchRearm] %s on %s: rearmed=%d mismatched=%d failed=%d (%s)",
    job_key, tostring(record.platform_name), summary.rearmed, summary.mismatched, summary.failed, reason))
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
    return
  end
  local now = {}
  for _, s in pairs(sigs or {}) do now[s.signal.name] = s.count end
  for _, captured in ipairs(item.captured_outputs) do
    local live = now[captured.signal.name]
    if live == nil then
      item.outcome = string.format("mismatch: %s absent after re-arm (captured %d)",
        captured.signal.name, captured.count)
      return
    elseif live ~= captured.count then
      -- The latch holds, but not at the captured count — caveat (b) territory. Reported, not hidden.
      item.outcome = string.format("mismatch: %s=%d after re-arm (captured %d)",
        captured.signal.name, live, captured.count)
      return
    end
  end
  item.outcome = "rearmed"
end

--- Service every pending re-arm job. Called from AsyncProcessor.process_tick BEFORE its
--- async_jobs early-return — this queue outlives the import job that created it.
function LatchRearm.process_tick()
  if not storage.latch_rearm_jobs then return end
  for job_key, record in pairs(storage.latch_rearm_jobs) do
    if game.tick >= (record.at_tick or 0) then
      if record.stage == "force" and platform_paused(record.items) then
        if game.tick >= (record.patience_deadline or 0) then
          for _, item in ipairs(record.items) do
            item.outcome = item.outcome or "not re-armed: platform stayed paused (gateway park?)"
          end
          finalize(job_key, record, "platform never unpaused within patience window")
        end
        -- else: keep waiting; combinators cannot evaluate on a paused platform (R2: only the
        -- pause stops them), so forcing now and restoring later would re-arm nothing.
      elseif record.stage == "force" then
        local any = write_all(record.items, forced_parameters, "force")
        if any then
          record.stage = "restore"
          record.at_tick = game.tick + FORCE_TO_RESTORE_TICKS
        else
          finalize(job_key, record, "no live decider survived to the force stage")
        end
      elseif record.stage == "restore" then
        -- Restore from the CAPTURED payload parameters unconditionally — even items that failed
        -- the force write get their captured config re-asserted (idempotent, never harmful).
        write_all(record.items, function(item) return item.captured_parameters end, "restore", true)
        record.stage = "verify"
        record.at_tick = game.tick + RESTORE_TO_VERIFY_TICKS
      elseif record.stage == "verify" then
        for _, item in ipairs(record.items) do verify_item(item) end
        finalize(job_key, record, "completed")
      else
        finalize(job_key, record, "unknown stage '" .. tostring(record.stage) .. "'")
      end
    end
  end
end

return LatchRearm
