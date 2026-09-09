local name = '__NAME__'
local mode = '__MODE__'
local function snapshot(entity)
  assert(entity and entity.valid and entity.type == 'decider-combinator', 'missing decider')
  local cb = entity.get_control_behavior()
  local status='unknown'
  for label,id in pairs(defines.entity_status) do if id==entity.status then status=label end end
  return {register=cb.signals_last_tick, network=entity.get_signals(defines.wire_connector_id.combinator_output_red),
    parameters=cb.parameters, status=status, tick=game.tick}
end
if mode == 'cleanup' then
  local st = storage.__latch_baseline
  if st then
    assert(st.name == name, 'foreign fixture storage')
    assert(not (storage.latch_rearm_jobs or {})[name], 'rearm still active; do not bypass cleanup')
    if st.platform and st.platform.valid then game.delete_surface(st.platform.surface) end
    if storage.latch_rearm_results then storage.latch_rearm_results[name] = nil end
    storage.__latch_baseline = nil
  end
  return {ok=true}
end
if mode == 'build' or mode == 'cleanup-proof' then
  assert(not storage.__latch_baseline, 'fixture storage already present')
  for _, p in pairs(game.forces.player.platforms) do assert(not p.name:find('latch-baseline-',1,true), 'foreign fixture') end
  local p = assert(game.forces.player.create_space_platform{name=name, planet='nauvis', starter_pack='space-platform-starter-pack'})
  local st = {name=name, platform=p, sources={}, destinations={}, seeds={}}
  storage.__latch_baseline = st
  p.apply_starter_pack()
  if mode == 'cleanup-proof' then error('owned cleanup proof') end
  local s = p.surface
  local tiles = {}
  for x=4,45 do for y=0,14 do tiles[#tiles+1]={name='space-platform-foundation',position={x,y}} end end
  s.set_tiles(tiles)
  for x=7,19,4 do assert(s.create_entity{name='solar-panel',position={x,11},force='player'}) end
  local wc=defines.wire_connector_id
  local signalS={type='virtual',name='signal-S'}
  local each={type='virtual',name='signal-each'}
  st.rules={
    {conditions={{first_signal=signalS,comparator='>',constant=0}}, outputs={{signal=signalS,copy_count_from_input=false,constant=1}},else_outputs={}},
    {conditions={{first_signal=each,comparator='!=',constant=0}},outputs={{signal=each,copy_count_from_input=true}},else_outputs={}}
  }
  for case=1,2 do
    local y=case*3
    local seed=assert(s.create_entity{name='constant-combinator',position={5.5,y},force='player'})
    st.seeds[#st.seeds+1]=seed
    local cb=seed.get_control_behavior()
    local section=cb.get_section(1) or cb.add_section()
    section.set_slot(1,{value={type='virtual',name='signal-S',quality='normal'},min=47})
    if case==2 then
      section.set_slot(2,{value={type='virtual',name='signal-Q',quality='normal'},min=-7})
      section.set_slot(3,{value={type='item',name='iron-plate',quality='rare'},min=3})
    end
    for col=0,3 do
      local e=assert(s.create_entity{name='decider-combinator',position={8.5+col*8,y},direction=defines.direction.east,force='player'})
      assert(e.type=='decider-combinator')
      e.get_control_behavior().parameters=st.rules[case]
      assert(e.get_wire_connector(wc.combinator_output_red,true).connect_to(e.get_wire_connector(wc.combinator_input_red,true)))
      if col==0 then
        st.sources[case]=e
        assert(seed.get_wire_connector(wc.circuit_red,true).connect_to(e.get_wire_connector(wc.combinator_input_red,true)))
      else st.destinations[#st.destinations+1]={entity=e,case=case,repetition=col} end
    end
  end
  return {built=true,engine=script.active_mods.base,mods=script.active_mods,tick=game.tick}
end
local st=assert(storage.__latch_baseline,'missing fixture')
assert(st.name==name,'fixture owner mismatch')
if mode=='remove-seeds' then
  for _, e in ipairs(st.seeds) do assert(e.destroy()) end
  st.seeds={}
  return {ok=true,tick=game.tick}
end
if mode=='observe' then
  local out={sources={},destinations={},tick=game.tick,result=(storage.latch_rearm_results or {})[name],pending=(storage.latch_rearm_jobs or {})[name]~=nil}
  for _,e in ipairs(st.sources) do out.sources[#out.sources+1]=snapshot(e) end
  for _,row in ipairs(st.destinations) do out.destinations[#out.destinations+1]={case=row.case,repetition=row.repetition,state=snapshot(row.entity)} end
  return out
end
if mode=='candidate-seed' then
  st.original_parameters={}
  for i,row in ipairs(st.destinations) do
    local cb=row.entity.get_control_behavior()
    st.original_parameters[i]=cb.parameters
    local outputs={}
    for _,s in pairs(st.sources[row.case].get_control_behavior().signals_last_tick or {}) do
      outputs[#outputs+1]={signal=s.signal,copy_count_from_input=false,constant=s.count}
    end
    assert(#outputs>0,'empty source register')
    cb.parameters={conditions={{first_signal={type='virtual',name='signal-S'},comparator='>=',constant=-2147483648}},
      outputs=outputs,else_outputs={}}
  end
  return {seeded=#st.destinations,tick=game.tick}
end
if mode=='candidate-restore' then
  for i,row in ipairs(st.destinations) do row.entity.get_control_behavior().parameters=st.original_parameters[i] end
  return {restored=#st.destinations,tick=game.tick}
end
if mode=='baseline' then
  local rearm=assert(package.loaded['__level__/modules/surface_export/import_phases/latch_rearm.lua'],'deployed module not loaded')
  local job={job_id=name,platform_name=name,entity_map={},entities_to_create={}}
  local wc=defines.wire_connector_id
  for _,row in ipairs(st.destinations) do
    local e=row.entity
    job.entity_map[e.unit_number]=e
    job.entities_to_create[#job.entities_to_create+1]={entity_id=e.unit_number,type=e.type,position=e.position,
      control_behavior={parameters=st.sources[row.case].get_control_behavior().parameters},
      specific_data={output_signals=st.sources[row.case].get_control_behavior().signals_last_tick},
      circuit_connections={{target_entity_id=e.unit_number,source_circuit_id=wc.combinator_output_red,target_circuit_id=wc.combinator_input_red}}}
  end
  return {scheduled=rearm.schedule(job),tick=game.tick}
end
error('unknown fixture mode')
