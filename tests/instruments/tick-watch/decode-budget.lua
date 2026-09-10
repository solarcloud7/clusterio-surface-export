-- Decode-only lab on the unoccupied source host. Never creates a platform/job.
local KEY = 'surface_export_decode_budget_lab'
local function equal(a, b)
  if type(a) ~= type(b) then return false end
  if type(a) ~= 'table' then return a == b end
  for k, v in pairs(a) do if not equal(v, b[k]) then return false end end
  for k in pairs(b) do if a[k] == nil then return false end end
  return true
end
return function(action, id, arg)
  assert(id:match('^decodebudget%-%w+$'), 'owned ID required')
  local state = package.loaded[KEY]
  if action == 'prepare' then
    assert(not state, 'another decode lab exists')
    assert(script.active_mods.base == '2.1.17')
    assert(#game.connected_players == 0, 'decode lab requires an unoccupied host')
    assert(not game.tick_paused and table_size(storage.async_jobs or {}) == 0)
    local cached = assert(storage.platform_exports[arg.export_id], 'source export missing')
    assert(#cached.payload < 200000, 'compressed payload budget exceeded')
    state = {id=id, export_id=arg.export_id, payload=cached.payload, parts={}}
    package.loaded[KEY] = state -- Removal also covers a partially failed preparation.
    state.json = assert(helpers.decode_string(cached.payload))
    assert(#state.json <= 4000000, 'decoded payload budget exceeded')
    state.expected = assert(helpers.json_to_table(state.json))
    local split = {entities=true, tiles=true, belt_side_groups=true}
    local metadata = {}
    for k,v in pairs(state.expected) do if not split[k] then metadata[k]=v end end
    state.parts[1] = {json=helpers.table_to_json(metadata), kind='metadata'}
    for _, range in ipairs(arg.ranges) do
      assert(split[range.key], 'unexpected section')
      local batch = {}
      for i=range.first,range.last do batch[#batch+1]=assert(state.expected[range.key][i]) end
      state.parts[#state.parts+1] = {json=helpers.table_to_json({[range.key]=batch}),key=range.key}
    end
    assert(#state.parts <= 100, 'part-count budget exceeded')
    local max_bytes = 0
    for _,part in ipairs(state.parts) do
      assert(#part.json <= 65536, 'native encoded part exceeds 64 KiB')
      max_bytes = math.max(max_bytes,#part.json)
    end
    return {success=true,engine=script.active_mods.base,bytes=#state.json,parts=#state.parts,maxPartBytes=max_bytes}
  end
  if action == 'status' then return {success=true,present=state~=nil,id=state and state.id} end
  if action == 'cleanup' and not state then return {success=true,removed=true} end
  assert(state and state.id==id, 'lab absent or owned by another run')
  if action == 'cleanup' then
    package.loaded[KEY]=nil
    assert(storage.platform_exports[state.export_id].payload==state.payload, 'source payload changed')
    return {success=true,removed=true,sourcePayloadUnchanged=true}
  end
  if action == 'begin' then
    assert(arg=='full' or arg=='parts')
    state.mode=arg;state.index=1;state.result={};state.previous_tick=nil
    return {success=true}
  end
  assert(action=='step' and state.mode, 'invalid action')
  assert(not state.previous_tick or game.tick>state.previous_tick, 'no tick passed between decode calls')
  state.previous_tick=game.tick
  local profiler=helpers.create_profiler()
  local bytes
  if state.mode=='full' then
    bytes=#state.json;state.result=assert(helpers.json_to_table(state.json));state.index=2
  else
    local part=assert(state.parts[state.index]);bytes=#part.json
    local decoded=assert(helpers.json_to_table(part.json))
    if part.kind=='metadata' then state.result=decoded
    else
      local target=state.result[part.key] or {};state.result[part.key]=target
      for _,record in ipairs(decoded[part.key]) do target[#target+1]=record end
    end
    state.index=state.index+1
  end
  profiler.stop()
  local done=state.mode=='full' or state.index>#state.parts
  -- The complete structural oracle runs outside the measured decode/reassembly span.
  if done then assert(equal(state.expected,state.result),'decoded payload differs');state.mode=nil end
  rcon.print({'','[SE_DECODE_BUDGET_V1]',profiler})
  return {success=true,tick=game.tick,bytes=bytes,done=done,exactPayload=done and true or nil}
end
