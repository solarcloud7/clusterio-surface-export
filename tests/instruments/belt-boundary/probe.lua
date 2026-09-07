local fixture = helpers.json_to_table([=[__FIXTURE__]=])
local name, mode = "__NAME__", "__MODE__"
if script.active_mods.base ~= fixture.engine then error("engine pin mismatch") end
if (mode=="setup" or mode=="cleanup") and game.surfaces[name] then error("owned name already exists") end
local surface
local ok, result = pcall(function()
  surface = game.surfaces[name]
  local constructing = not surface
  if constructing then
    surface = game.create_surface(name, {width=64,height=64})
    surface.request_to_generate_chunks({0,0},1)
    surface.force_generate_chunk_requests()
    local tiles = {}
    for x=-12,0 do for y=-6,2 do tiles[#tiles+1]={name="lab-dark-1",position={x,y}} end end
    surface.set_tiles(tiles)
  end
  local entities = {}
  for _, data in ipairs(fixture.entities) do
    local e
    if constructing then e=surface.create_entity({name=data.name,position=data.position,direction=data.direction,force="player"})
    else e=surface.find_entity(data.name,data.position) end
    if not e or not e.valid or e.type ~= "transport-belt" then error("fixture construction failed") end
    e.disabled_by_script=true
    entities[data.id]=e
  end
  if mode == "cleanup" then error("injected cleanup failure") end
  if mode == "setup" then return {status="PASS",prepared=true,tick=game.tick} end
  local function observe()
    local rows, total, seen = {}, 0, {}
    for _, data in ipairs(fixture.entities) do
      local e=entities[data.id]
      for li=1,2 do
        local line=e.get_transport_line(li)
        for _, item in ipairs(line.get_detailed_contents()) do
          local stack=item.stack
          if not stack.valid_for_read then error("unreadable item stack") end
          rows[#rows+1]={id=data.id,line=li,uid=tostring(item.unique_id),n=stack.name,ct=stack.count,q=stack.quality.name,k=item.position*256}
          if not seen[item.unique_id] then total=total+stack.count; seen[item.unique_id]=true end
        end
      end
    end
    return {rows=rows,total=total}
  end
  local function counts()
    local values={}
    for gi,g in ipairs(fixture.groups) do
      local n, seen=0,{}
      for _,m in ipairs(g.members) do
        for _,item in ipairs(entities[m.id].get_transport_line(m.li).get_detailed_contents()) do
          if not seen[item.unique_id] then n=n+item.stack.count;seen[item.unique_id]=true end
        end
      end
      values[gi]=n
    end
    return values
  end
  local shape={}
  for gi,g in ipairs(fixture.groups) do
    local rep=entities[g.members[1].id].get_transport_line(g.members[1].li)
    for _,m in ipairs(g.members) do
      local line=entities[m.id].get_transport_line(m.li)
      shape[#shape+1]={group=gi,id=m.id,line=m.li,length=line.line_length,same=line.line_equals(rep)}
    end
  end
  local origin=game.tick
  local out={status="PASS",mode=mode,shape=shape,startTick=origin,steps={},before=observe(),mods=script.active_mods}
  if out.before.total ~= 0 then error("fixture not empty") end
  if mode ~= "smoke" then
    for gi,g in ipairs(fixture.groups) do
      for si,slot in ipairs(g.slots) do
        local base=(si-1)*3
        local id,li,source_k=g.item_source_positions[base+1],g.item_source_positions[base+2],g.item_source_positions[base+3]
        local e=entities[id]
        local line=e.get_transport_line(li)
        local minimum=math.floor(e.prototype.belt_speed*256+0.5)
        local top=math.floor(line.line_length*256+0.5)
        local want=math.min(top,math.max(minimum,source_k-minimum))
        local before=counts()
        local step={group=gi,slot=si,id=id,line=li,sourceK=source_k,before=before,requestedK=want}
        if mode=="force" then
          if source_k < 0 or source_k > top then error("captured position outside destination line; refusing clamp") end
          step.requestedK=source_k
          line.force_insert_at(source_k/256,{name=slot.n,quality=slot.q,count=slot.ct},slot.ct)
          step.inserted=true -- call completed; the independent physical oracle below owns the verdict
        else
          for k=want,minimum,-1 do
            if line.can_insert_at(k/256) and line.insert_at(k/256,{name=slot.n,quality=slot.q,count=slot.ct},slot.ct) then
              step.inserted=true;step.landedK=k;break
            end
          end
        end
        step.after=counts();step.physical=observe()
        out.steps[#out.steps+1]=step
        if not step.inserted or step.after[gi]-before[gi] ~= slot.ct then
          out.status="STOP";out.cause=step.inserted and "successful insertion crossed side group" or "slot did not insert"
          out.endTick=game.tick;return out
        end
      end
    end
  end
  out.endTick=game.tick
  return out
end)
if ok and mode=="setup" then return result end
if surface and surface.valid then game.delete_surface(surface) end
-- The engine can defer deletion until this callback returns. The runner verifies absence
-- in an independent RCON read; presence within this callback is not a cleanup failure.
if not ok then return {status=mode=="cleanup" and tostring(result):find("injected cleanup failure",1,true) and "PASS" or "HARNESS_ERROR",error=tostring(result)} end
if result.startTick~=result.endTick then result.status="HARNESS_ERROR" end
return result
