local lab=storage.__belt_helper_experiment
assert(lab and lab.token=="__TOKEN__", "experiment ownership missing")
local input=helpers.json_to_table(lab.input)
local name,mode,arm="__NAME__","__MODE__","__ARM__"
local fixture=input.fixtures["__FIXTURE__"]
assert(script.active_mods.base=="2.1.17", "engine pin mismatch")
local surface=game.surfaces[name]
local ok,result=pcall(function()
  if mode=="setup" or mode=="cleanup" then
    assert(not surface, "surface already exists")
    surface=game.create_surface(name,{width=256,height=256})
    surface.request_to_generate_chunks({0,0},4)
    surface.force_generate_chunk_requests()
    local tiles={}
    for _,d in ipairs(fixture.entities) do
      for x=math.floor(d.position.x)-2,math.floor(d.position.x)+2 do
        for y=math.floor(d.position.y)-2,math.floor(d.position.y)+2 do
          tiles[#tiles+1]={name="lab-dark-1",position={x,y}}
        end
      end
    end
    surface.set_tiles(tiles)
    for _,d in ipairs(fixture.entities) do
      local e=surface.create_entity{name=d.name,position=d.position,direction=d.direction,
        type=d.belt_to_ground_type,force="player",quality=d.quality}
      assert(e and e.valid, "entity construction failed: "..d.name)
    end
    if mode=="cleanup" then error("injected cleanup failure") end
    return {status="PASS",prepared=true,tick=game.tick}
  end
  assert(surface and surface.valid, "prepared surface missing")
  local modules,loading={},{}
  local function require_local(path)
    if modules[path] then return modules[path] end
    assert(not loading[path], "circular require: "..path)
    loading[path]=true
    local source=assert(input.modules[path],"unbundled module: "..path)
    if path==input.helper and arm=="force" then source=input.candidate end
    if path==input.helper and arm=="baseline" then source=input.baseline or source end
    local constructor=assert(load("return function(require)\n"..source.."\nend",path))()
    local module=constructor(require_local)
    modules[path]=module;loading[path]=nil
    return module
  end
  local helper=require_local(input.helper)
  local map,pairs_to_capture={},{}
  for _,d in ipairs(fixture.entities) do
    local e=assert(surface.find_entity(d.name,d.position),"prepared entity missing")
    -- Item arming, restoration and observation share one callback. No scheduling yield
    -- occurs with items present; transport-line movement cannot satisfy this oracle.
    map[d.id]=e;pairs_to_capture[#pairs_to_capture+1]={id=d.id,entity=e}
  end
  local groups=fixture.groups
  -- Observe physical tuples independently of the helper's counters and validator.
  local function observe()
    local rows,seen={},{}
    for gi,g in ipairs(groups) do
      for _,m in ipairs(g.members) do
        local line=map[m.id].get_transport_line(m.li)
        assert(line and line.valid,"invalid transport line")
        for _,it in ipairs(line.get_detailed_contents()) do
          if not seen[it.unique_id] then
            seen[it.unique_id]=true
            local s=it.stack
            local row={group=gi,id=m.id,line=m.li,k=it.position*256,n=s.name,q=s.quality.name,ct=s.count}
            if fixture.stateful then
              row.health=s.health
              if s.name=="firearm-magazine" then row.ammo=s.ammo end
              if s.name=="repair-pack" then row.durability=s.durability end
              if s.is_blueprint then row.blueprint=s.get_blueprint_entities();row.label=s.label end
              if s.name=="bioflux" then row.spoil=s.spoil_percent end
            end
            rows[#rows+1]=row
          end
        end
      end
    end
    return rows
  end
  local before={}
  if fixture.stateful then
    for i,d in ipairs(fixture.entities) do
      local line=map[d.id].get_transport_line(1)
      local stacks=d.stacks
      for j,item in ipairs(stacks) do
        line.force_insert_at(j/4,{name=item.name,quality=item.quality or "normal",count=1},1)
        local s
        for _,it in ipairs(line.get_detailed_contents()) do if it.position==j/4 then s=it.stack end end
        assert(s,"armed stack not at requested position")
        assert(s.name==item.name,"arming found wrong item")
        if item.health then s.health=item.health end
        if item.ammo then s.ammo=item.ammo end
        if item.durability then s.durability=item.durability end
        if item.spoil then s.spoil_percent=item.spoil end
        if item.name=="blueprint" then
          s.set_blueprint_entities{{entity_number=1,name="transport-belt",position={0.5,0.5}},
            {entity_number=2,name="wooden-chest",position={1.5,0.5}}}
          s.label="force-helper-blueprint"
        end
      end
    end
    groups=helper.capture_side_groups(pairs_to_capture)
    before=observe()
    for _,d in ipairs(fixture.entities) do
      for li=1,map[d.id].get_max_transport_line_index() do map[d.id].get_transport_line(li).clear() end
    end
  end
  if not lab.work then assert(#observe()==0,"destination must be empty") end
  local valid,why=helper.validate_side_groups(groups);assert(valid,why)
  if arm=="batched" then
    local planner=require_local("modules/surface_export/import_phases/belt_batches")
    if not lab.work then
      lab.work={plan=planner.plan(groups,map,500),completed=0,placed=0,unplaced=0,anomalies=0}
    end
    local work=lab.work
    local chunk=work.plan.batches[work.completed+1]
    local slice={};for _,i in ipairs(chunk.indices) do slice[#slice+1]=groups[i] end
    local tick=game.tick
    local profiler=helpers.create_profiler()
    local placed,unplaced,anomalies=helper.restore_side_groups(slice,map,name)
    profiler.stop();log({"","[BELT_BATCH] ",name," batch ",work.completed+1," ",profiler})
    work.completed=work.completed+1;work.placed=work.placed+placed
    work.unplaced=work.unplaced+unplaced;work.anomalies=work.anomalies+anomalies
    return {status="PASS",pending=work.completed<#work.plan.batches,completed=work.completed,
      startTick=tick,endTick=game.tick,placed=work.placed,unplaced=work.unplaced,anomalies=work.anomalies,
      plan=work.plan,rows=observe(),groups=groups,stats={},mods=script.active_mods}
  end
  local start=game.tick
  local placed,unplaced,anomalies,delta,stats=helper.restore_side_groups(groups,map,name)
  local after=observe()
  return {status="PASS",startTick=start,endTick=game.tick,placed=placed,unplaced=unplaced,
    anomalies=anomalies,delta=delta,stats=stats,rows=after,before=before,groups=groups,mods=script.active_mods}
end)
if ok and (mode=="setup" or result.pending) then return result end
if surface and surface.valid then game.delete_surface(surface) end
if not ok then return {status=mode=="cleanup" and tostring(result):find("injected cleanup failure",1,true) and "PASS" or "HARNESS_ERROR",error=tostring(result)} end
return result
