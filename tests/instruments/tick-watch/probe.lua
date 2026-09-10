-- Temporary, deterministic wrapper. Profiler readings never control game logic.
local KEY = "surface_export_tick_watch"
local module = assert(package.loaded["__level__/modules/surface_export/core/async-processor.lua"])
local function snapshot(clock)
  local value = helpers.create_profiler(true)
  value.add(clock)
  return value
end
local function join(parts)
  while #parts > 16 do
    local next_parts = {}
    for first = 1, #parts, 16 do
      local group = {""}
      for i = first, math.min(first + 15, #parts) do group[#group + 1] = parts[i] end
      next_parts[#next_parts + 1] = group
    end
    parts = next_parts
  end
  local out = {""}
  for _, part in ipairs(parts) do out[#out + 1] = part end
  return out
end
return function(action, id, limit)
  assert(type(id) == "string" and id:match("^tickwatch%-%w+$"), "owned recorder ID required")
  local state = package.loaded[KEY]
  if action == "arm" then
    assert(not state, "another tick recorder exists")
    assert(not package.loaded.surface_export_callback_profile_fixture, "callback profiler already installed")
    assert(limit >= 2 and limit <= 7200 and limit % 1 == 0, "invalid sample budget")
    state = {id=id, original=module.process_tick, clock=helpers.create_profiler(), rows={}, limit=limit}
    package.loaded[KEY] = state
    state.wrapper = function(...)
      if #state.rows >= state.limit then
        state.truncated = true
        module.process_tick = state.original
        return state.original(...)
      end
      local overhead = helpers.create_profiler()
      local row = {tick=game.tick, offset=snapshot(state.clock), speed=game.speed}
      state.rows[#state.rows + 1] = row
      local execution = helpers.create_profiler(true)
      overhead.stop()
      execution.restart()
      local result = table.pack(pcall(state.original, ...))
      execution.stop()
      overhead.restart()
      row.execution = execution
      row.success = result[1]
      row.overhead = overhead
      overhead.stop()
      if not result[1] then error(result[2], 0) end
      return table.unpack(result, 2, result.n)
    end
    module.process_tick = state.wrapper
    local marker = "surface-export-tests/" .. id .. "-start.txt"
    helpers.write_file(marker,id,false,0)
    local player=game.get_player("solarcloud7")
    if player and player.connected then helpers.write_file(marker,id,false,player.index) end
    return {success=true,id=id,limit=limit}
  end
  if action == "status" then
    return {success=true,present=state~=nil,id=state and state.id}
  end
  assert(state and state.id == id, "recorder absent or owned by another run")
  assert(module.process_tick == state.wrapper or (state.truncated and module.process_tick == state.original), "recorder wrapper was replaced")
  assert(action == "finish" or action == "cancel", "unknown action")
  module.process_tick = state.original
  package.loaded[KEY] = nil
  if action == "cancel" then return {success=true,removed=true} end
  local total = snapshot(state.clock)
  local parts = {helpers.table_to_json{v=1,id=id,engine=script.active_mods.base,rows=#state.rows,truncated=state.truncated==true}, "\n"}
  for _, row in ipairs(state.rows) do
    parts[#parts+1] = {"", helpers.table_to_json{tick=row.tick,speed=row.speed,success=row.success},
      "\t",row.offset,"\t",row.execution,"\t",row.overhead,"\n"}
  end
  local text = join(parts)
  local file = "surface-export-tests/" .. id .. ".tsv"
  local total_file = "surface-export-tests/" .. id .. "-total.txt"
  helpers.write_file(total_file,{"",total},false,0)
  -- Each process renders its own profiler values. Do not align their offsets.
  helpers.write_file(file,text,false,0)
  local player=game.get_player("solarcloud7")
  if player and player.connected then
    helpers.write_file(total_file,{"",total},false,player.index)
    helpers.write_file(file,text,false,player.index)
  end
  return {success=true,removed=true,rows=#state.rows,truncated=state.truncated==true,file=file}
end
