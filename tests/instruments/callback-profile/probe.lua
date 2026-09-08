local KEY = "surface_export_callback_profile_fixture"
local module = assert(package.loaded["__level__/modules/surface_export/core/async-processor.lua"])
return function(action, prefix)
  assert(type(prefix) == "string" and prefix:sub(1, 17) == "transfer-cleanup-", "fixture prefix required")
  local state = package.loaded[KEY]
  if action == "arm" then
    assert(not state, "another callback profiler is installed")
    state = {original = module.process_tick, records = {}, prefix = prefix}
    package.loaded[KEY] = state
    module.process_tick = function(...)
      local jobs = {}
      for id, job in pairs(storage.async_jobs or {}) do
        if (job.platform_name or ""):sub(1, #prefix) == prefix then jobs[#jobs + 1] = id end
      end
      if #jobs == 0 then return state.original(...) end
      if #state.records >= 64 then state.truncated = true; return state.original(...) end
      local profiler = helpers.create_profiler()
      local result = table.pack(pcall(state.original, ...))
      profiler.stop()
      state.records[#state.records + 1] = {meta = {tick = game.tick, jobs = jobs, success = result[1]}, profiler = profiler}
      if not result[1] then error(result[2], 0) end
      return table.unpack(result, 2, result.n)
    end
    return {success = true}
  end
  assert(action == "disarm", "unknown profiler action")
  if not state then return {success = true, records = 0} end
  assert(state.prefix == prefix, "profiler belongs to another fixture")
  module.process_tick = state.original
  package.loaded[KEY] = nil
  for _, record in ipairs(state.records) do
    rcon.print({"", "[SE_CALLBACK_V1]", helpers.table_to_json(record.meta), "\t", record.profiler})
  end
  return {success = true, records = #state.records, truncated = state.truncated == true}
end
