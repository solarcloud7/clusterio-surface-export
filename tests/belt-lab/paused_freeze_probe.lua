-- BELT-R13 probe: paused-platform belt physics [empirical, 2.0.77]
-- Instrument: the dedicated feeder-free probe strip on lab-omnibus-platform-v1 — six turbo belts
-- at (-31.5..-26.5, 16.5), no loader/infinity-container within reach, outside every clone
-- workspace (the R11/R12 clone sections wipe their own areas and must never touch the strip).
-- All line handles are fetched FRESH in the same execution as any write (BELT-R11 aged-clone
-- leak class: stale window handles can land writes in a downstream window's frame).
-- Modes (MODE global, set by run-r13-paused-belt-physics.ps1):
--   (none)         read: per-line item vector, totals, active counts, tick
--   MODE='seed'    place 3 iron-plate on strip belts at k-floored positions
--   MODE='thaw'    write active=true to all strip belts, read back same-execution (belts on a
--                  paused platform REJECT the write), then write active=false again
--   MODE='insert'  insert 1 iron-plate on the most-westerly empty line-1 strip belt
--   MODE='cleanup' remove every iron-plate from the strip (returns it to empty)
-- No trailing '--' comments below (driver strips full-line comments, collapses newlines).
local out={success=false} local ok,err=pcall(function()
local p for _,q in pairs(game.forces.player.platforms) do if q.valid and q.name=='lab-omnibus-platform-v1' then p=q end end
if not p then out.abort='platform lab-omnibus-platform-v1 not found' return end
local s=p.surface
local es={}
for x=0,5 do
  local e=s.find_entity('turbo-transport-belt',{-31.5+x,16.5})
  if not e then out.abort='strip belt missing at x='..(-31.5+x) return end
  es[#es+1]=e
end
if MODE=='seed' then
  local seeded=0
  for i=1,3 do
    local e=es[i]
    local l=e.get_transport_line(1)
    local kmin=math.floor(e.prototype.belt_speed*256+0.5)
    for k=math.floor(l.line_length*256+0.5),kmin,-1 do
      if l.can_insert_at(k/256) then l.insert_at(k/256,{name='iron-plate',count=1},1) seeded=seeded+1 break end
    end
  end
  out.seeded=seeded
elseif MODE=='thaw' then
  for _,e in ipairs(es) do e.active=true end
  local stuck=0 for _,e in ipairs(es) do if e.active then stuck=stuck+1 end end
  out.active_after_write=stuck
  for _,e in ipairs(es) do e.active=false end
elseif MODE=='insert' then
  local done=false
  for _,e in ipairs(es) do
    local l=e.get_transport_line(1)
    if l.get_item_count()==0 then
      local kmin=math.floor(e.prototype.belt_speed*256+0.5)
      for k=math.floor(l.line_length*256+0.5),kmin,-1 do
        if l.can_insert_at(k/256) then
          l.insert_at(k/256,{name='iron-plate',count=1},1)
          done=(l.get_item_count()==1)
          out.insert_x=e.position.x out.k=k
          break
        end
      end
      break
    end
  end
  out.insert_ok=done
elseif MODE=='cleanup' then
  local removed=0
  for _,e in ipairs(es) do
    for li=1,e.get_max_transport_line_index() do
      removed=removed+e.get_transport_line(li).remove_item({name='iron-plate',count=100})
    end
  end
  out.removed=removed
end
local seen={} local tot=0 local per={}
for i,e in ipairs(es) do
  for li=1,e.get_max_transport_line_index() do
    for _,it in ipairs(e.get_transport_line(li).get_detailed_contents()) do
      local uid=tostring(it.unique_id)
      if not seen[uid] then
        seen[uid]=true tot=tot+it.stack.count
        local k=i..'.'..li per[k]=(per[k] or 0)+it.stack.count
      end
    end
  end
end
local vec={}
for i,e in ipairs(es) do
  for li=1,e.get_max_transport_line_index() do
    local k=i..'.'..li
    if per[k] then vec[#vec+1]=string.format('b%d.L%d=%d',i,li,per[k]) end
  end
end
out.vec=table.concat(vec,' ') out.total=tot
local act=0 for _,e in ipairs(es) do if e.active then act=act+1 end end
out.active_count=act out.entities=#es
out.tick=game.tick out.platform_paused=p.paused
out.success=true
end) if not ok then out.error=tostring(err) end rcon.print(helpers.table_to_json(out))
