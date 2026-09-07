local LatchRearm = require("modules/surface_export/import_phases/latch_rearm")
local SurfaceLock = require("modules/surface_export/utils/surface-lock")

local function latch_rearm_params_selftest()
  local details, passed, failed = {}, 0, 0
  local function check(name, condition)
    if condition then passed = passed + 1 else failed = failed + 1 end
    details[#details + 1] = { name = name, ok = condition == true }
  end
  local signals = {
    { signal = { type = "virtual", name = "signal-S" }, count = 47 },
    { signal = { type = "virtual", name = "signal-Q" }, count = -7 },
    { signal = { type = "item", name = "iron-plate", quality = "rare" }, count = 3 },
  }
  local original = {
    conditions = {{ first_signal = signals[1].signal, comparator = ">", constant = 0 }},
    outputs = {{ signal = signals[1].signal, copy_count_from_input = true }},
    else_outputs = {{ signal = signals[2].signal, constant = 1, copy_count_from_input = false }},
    future_field = "preserved",
  }
  local item = { captured_outputs = signals, captured_parameters = original }
  local seed = LatchRearm.forced_parameters(item)
  check("all captured signals have explicit outputs", #seed.outputs == 3)
  check("signed counts preserved", seed.outputs[1].constant == 47 and seed.outputs[2].constant == -7)
  check("quality preserved", seed.outputs[3].signal.quality == "rare")
  check("input copying disabled", seed.outputs[1].copy_count_from_input == false
    and seed.outputs[2].copy_count_from_input == false and seed.outputs[3].copy_count_from_input == false)
  check("seed cannot fire alternate outputs", #seed.else_outputs == 0)
  check("seed condition always true", seed.conditions[1].constant == -2147483648
    and seed.conditions[1].comparator == ">=")
  check("future parameter fields preserved", seed.future_field == "preserved")
  check("captured rules untouched", original.outputs[1].copy_count_from_input and #original.else_outputs == 1
    and original.conditions[1].constant == 0)
  check("full register equality", LatchRearm.register_matches(item, signals))
  local extra = { signals[1], signals[2], signals[3], {signal={type="virtual",name="signal-A"},count=1} }
  check("unexpected extra signal rejected", not LatchRearm.register_matches(item, extra))
  check("missing signal rejected", not LatchRearm.register_matches(item, {signals[1]}))
  check("empty register rejected", not LatchRearm.register_matches(item, nil))
  check("only working counts as evaluating", LatchRearm.status_is_live("working")
    and not LatchRearm.status_is_live("low_power") and not LatchRearm.status_is_live(nil))

  -- Exercise error paths with mock entities, without changing the game clock or any surface.
  local saved_jobs, saved_results = storage.latch_rearm_jobs, storage.latch_rearm_results
  local ok, err = xpcall(function()
    local parameters, register, reject_restore = original, signals, false
    local behavior = setmetatable({}, {
      __index = function(_, key)
        if key == "parameters" then return parameters end
        if key == "signals_last_tick" then return register end
      end,
      __newindex = function(_, key, value)
        if key == "parameters" then
          if reject_restore and value == original then error("injected original-rule write failure") end
          parameters = value
        end
      end,
    })
    local entity = { valid=true, surface={index=-123}, status=defines.entity_status.working,
      get_control_behavior=function() return behavior end }
    local function install(stage)
      item = { entity=entity, entity_id=-1, captured_outputs=signals, captured_parameters=original }
      storage.latch_rearm_jobs = { selftest={version=2,stage=stage,at_tick=game.tick,items={item}} }
      storage.latch_rearm_results = {}
    end
    local function step()
      local job = storage.latch_rearm_jobs.selftest
      if job then job.at_tick = game.tick end
      LatchRearm.process_tick()
    end
    install("preflight")
    check("pending surface guarded", LatchRearm.pending_on_surface(-123) and not LatchRearm.pending_on_surface(-124))
    local locked, lock_error = SurfaceLock.lock_platform({valid=true,surface={valid=true,index=-123}}, nil)
    check("actual export lock rejects pending restoration", locked == false
      and lock_error == "Circuit memory restoration is still pending on this platform")
    step(); step(); step(); step()
    check("verified seed completed", storage.latch_rearm_results.selftest.rearmed == 1)
    check("original parameters restored", parameters == original)
    check("completed surface released", not LatchRearm.pending_on_surface(-123))

    local dark_parameters = original
    local dark_behavior = setmetatable({}, {
      __index = function(_, key) if key == "parameters" then return dark_parameters end end,
      __newindex = function(_, key, value) if key == "parameters" then dark_parameters = value end end,
    })
    local dark_entity = { valid=true, status=defines.entity_status.no_power,
      get_control_behavior=function() return dark_behavior end }
    install("preflight")
    local dark_item = {entity=dark_entity, entity_id=-2, captured_outputs=signals, captured_parameters=original}
    storage.latch_rearm_jobs.selftest.items[2] = dark_item
    -- An old saved deadline must not preserve the removed retry policy.
    storage.latch_rearm_jobs.selftest.power_deadline = game.tick + 1800
    step(); step()
    check("ready sibling seeded without waiting", item.seed_written == true)
    check("dark sibling fails without seed writes", dark_item.failed and not dark_item.seed_written
      and dark_parameters == original and dark_item.outcome:find("no_power", 1, true) ~= nil)
    step(); step()
    check("mixed job finishes with separate outcomes", storage.latch_rearm_results.selftest.rearmed == 1
      and storage.latch_rearm_results.selftest.failed == 1)

    install("seed_verify"); item.seed_written = true; entity.status = defines.entity_status.no_power
    step(); step()
    check("power loss cannot verify stale matching signals", storage.latch_rearm_results.selftest.failed == 1
      and parameters == original)
    entity.status = defines.entity_status.working

    install("seed_verify"); item.seed_written = true; register = extra; reject_restore = true
    step()
    check("restore failure is retained after mismatch", item.failed and item.outcome:find("restore write failed",1,true) ~= nil)
    check("failed restore keeps pending guard", LatchRearm.pending_on_surface(-123) and storage.latch_rearm_results.selftest == nil)
    reject_restore = false; step(); step()
    check("restore retry cannot turn failure into success", storage.latch_rearm_results.selftest.failed == 1)
    check("retry restores original rules", parameters == original)

    install("seed_verify"); item.seed_written = true; register = signals
    step(); register = extra; step()
    check("changed register reported as resumed without clear", storage.latch_rearm_results.selftest.resumed == 1
      and storage.latch_rearm_results.selftest.cleared == 0 and parameters == original)

    install("clear_restore"); storage.latch_rearm_jobs.selftest.version = nil
    step(); step()
    check("legacy pending job restores and reports interruption", storage.latch_rearm_results.selftest.failed == 1
      and parameters == original)
    install("restore"); entity.valid = false; step(); step()
    check("removed entity does not leave pending job", storage.latch_rearm_results.selftest.failed == 1
      and storage.latch_rearm_jobs.selftest == nil)
  end, debug.traceback)
  storage.latch_rearm_jobs, storage.latch_rearm_results = saved_jobs, saved_results
  check("mock state-machine harness completed", ok)
  if not ok then
    log("[latch-rearm-params-selftest] " .. tostring(err))
    details[#details].msg = tostring(err)
  end
  return { passed=passed, failed=failed, total=passed+failed, details=details }
end
return latch_rearm_params_selftest
