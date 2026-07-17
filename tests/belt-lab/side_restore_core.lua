-- BELT-R11 / BELT-R12 shared core: side-scoped belt reconstruction proof [empirical, 2.0.77]
-- Injected globals (set by the run-r11/run-r12 drivers before this body):
--   SRC_X1, SRC_X2  x-range of the SOURCE fixture on the lab-omnibus-platform-v1 platform (y 0..20)
--   DDX             clone offset east of the source
--   MODE            'clone'  wipe the clone area and re-clone source geometry + settings
--                   'restore' side-scoped reconstruction: source line_equals groups -> clone
--                             windows (ord:li bridge), reverse first-fit, k >= belt_speed*256,
--                             physical side-census delta validation, cross-side leak undo
-- Method provenance: owner's nauvis 5x5 hybrid/reverse-first-fit result (informal) + coverage-rack
-- belt_speed law; see NOTEBOOK BELT-R11/BELT-R12. Fidelity contract: per-lane-side
-- (name,quality,count) multiset; position/order/window are NOT invariants.
-- No Lua line below may carry a trailing '--' comment: the driver strips full-line comments and
-- collapses newlines, so trailing comments would swallow the rest of the body.
local out={success=false} local ok,err=pcall(function()
local p for _,q in pairs(game.forces.player.platforms) do if q.valid and q.name=='lab-omnibus-platform-v1' then p=q end end
if not p then out.abort='platform lab-omnibus-platform-v1 not found' return end
local s=p.surface local force=game.forces.player
local X1,X2,DX=SRC_X1,SRC_X2,DDX
local BELTY={'transport-belt','underground-belt','splitter','loader'}
local function collect(a,b)
  local es=s.find_entities_filtered{area={{a,0},{b,20}},type=BELTY}
  table.sort(es,function(x,y) if x.position.y~=y.position.y then return x.position.y<y.position.y end return x.position.x<y.position.x end)
  return es
end
if MODE=='clone' then
  local wiped=0
  local WIPE={'transport-belt','underground-belt','splitter','loader','infinity-container'}
  for _,e in pairs(s.find_entities_filtered{area={{X1+DX,0},{X2+DX,20}},type=WIPE}) do e.destroy() wiped=wiped+1 end
  local srcE=collect(X1,X2)
  local srcChests=s.find_entities_filtered{area={{X1,0},{X2,20}},type='infinity-container'}
  if #srcE==0 then out.abort='source fixture empty' return end
  local tiles={} for x=X1+DX-2,X2+DX+2 do for y=0,20 do tiles[#tiles+1]={name='space-platform-foundation',position={x,y}} end end
  s.set_tiles(tiles)
  local made,cfails=0,{}
  for i,e in ipairs(srcE) do
    local args={name=e.name,position={e.position.x+DX,e.position.y},direction=e.direction,force=force}
    if e.type=='underground-belt' then args.type=e.belt_to_ground_type end
    if e.type=='loader' then args.type=e.loader_type end
    local c=s.create_entity(args)
    if c and c.valid then
      made=made+1 c.destructible=false
      if e.type=='splitter' then
        local sok,serr=pcall(function()
          c.splitter_filter=e.splitter_filter
          c.splitter_output_priority=e.splitter_output_priority
          c.splitter_input_priority=e.splitter_input_priority
        end)
        if not sok then cfails[#cfails+1]=i..' splitter-settings: '..tostring(serr) end
      end
      if e.type=='loader' then
        local lok,lerr=pcall(function()
          for fi=1,e.filter_slot_count do local f=e.get_filter(fi) if f then c.set_filter(fi,f) end end
          c.loader_filter_mode=e.loader_filter_mode
        end)
        if not lok then cfails[#cfails+1]=i..' loader-filter: '..tostring(lerr) end
      end
    else cfails[#cfails+1]=i..' create FAILED '..e.name end
  end
  local chests=0
  for _,e in pairs(srcChests) do
    local c=s.create_entity{name=e.name,position={e.position.x+DX,e.position.y},force=force}
    if c and c.valid then
      chests=chests+1 c.destructible=false
      local iok,ierr=pcall(function()
        c.infinity_container_filters=e.infinity_container_filters
        c.remove_unfiltered_items=e.remove_unfiltered_items
      end)
      if not iok then cfails[#cfails+1]='chest settings: '..tostring(ierr) end
    else cfails[#cfails+1]='chest create FAILED '..e.name end
  end
  out.wiped=wiped out.src_count=#srcE out.clone_made=made out.clone_chests=chests out.clone_fails=cfails
  out.success=(#cfails==0)
  return
end
local srcE=collect(X1,X2) local dstE=collect(X1+DX,X2+DX)
out.src_count=#srcE out.dst_count=#dstE
if #srcE==0 or #srcE~=#dstE then out.abort='enumeration mismatch (run clone section first)' return end
for i,e in ipairs(dstE) do for li=1,e.get_max_transport_line_index() do e.get_transport_line(li).clear() end end
local zero=0 for _,e in ipairs(dstE) do zero=zero+e.get_item_count() end
if zero~=0 then out.abort='clone not zero after clear' return end
local srefs={}
for i,e in ipairs(srcE) do for li=1,e.get_max_transport_line_index() do srefs[#srefs+1]={ord=i,li=li,line=e.get_transport_line(li)} end end
local sgroups={}
for _,r in ipairs(srefs) do local gi for j,g in ipairs(sgroups) do if r.line.line_equals(g.rep) then gi=j break end end
  if not gi then gi=#sgroups+1 sgroups[gi]={rep=r.line,refs={}} end
  sgroups[gi].refs[#sgroups[gi].refs+1]=r end
local totals={} local src_slots=0
for gi,g in ipairs(sgroups) do
  local seen={} g.slots={} g.expected={}
  for _,r in ipairs(g.refs) do for _,it in ipairs(r.line.get_detailed_contents()) do
    local id=tostring(it.unique_id)
    if not seen[id] then seen[id]=true
      local nm=it.stack.name local ql=it.stack.quality and it.stack.quality.name or 'normal' local ct=it.stack.count
      totals[nm]=(totals[nm] or 0)+ct
      g.slots[#g.slots+1]={n=nm,q=ql,ct=ct}
      g.expected[nm]=(g.expected[nm] or 0)+ct
      src_slots=src_slots+1
    end
  end end
  g.wins={}
  for _,r in ipairs(g.refs) do
    local de=dstE[r.ord]
    g.wins[#g.wins+1]={line=de.get_transport_line(r.li),kmin=math.floor(de.prototype.belt_speed*256+0.5),ord=r.ord,li=r.li,name=de.name}
  end
end
out.src_groups=#sgroups out.src_totals=totals out.src_slots=src_slots
local dlines={}
for i,e in ipairs(dstE) do for li=1,e.get_max_transport_line_index() do dlines[#dlines+1]={ord=i,li=li,line=e.get_transport_line(li)} end end
local function gstats(g)
  local seen={} local tot=0 local sl=0
  for _,w in ipairs(g.wins) do for _,it in ipairs(w.line.get_detailed_contents()) do
    local id=tostring(it.unique_id)
    if not seen[id] then seen[id]=true sl=sl+1 tot=tot+it.stack.count end
  end end
  return tot,sl
end
local function gnames(g)
  local seen={} local names={}
  for _,w in ipairs(g.wins) do for _,it in ipairs(w.line.get_detailed_contents()) do
    local id=tostring(it.unique_id)
    if not seen[id] then seen[id]=true names[it.stack.name]=(names[it.stack.name] or 0)+it.stack.count end
  end end
  return names
end
local function snap() local t={} for i,d in ipairs(dlines) do t[i]=d.line.get_item_count() end return t end
local function gtotal() local n=0 for _,e in ipairs(dstE) do n=n+e.get_item_count() end return n end
local placed,misses,calls,leaks_undone,unplaced=0,0,0,0,0
local leak_routes={}
local stop=false local stopmsg=nil
for gi,g in ipairs(sgroups) do
  if stop then break end
  for si,slot in ipairs(g.slots) do
    local done=false
    for wj=#g.wins,1,-1 do
      local w=g.wins[wj]
      local maxk=math.floor(w.line.line_length*256+0.5)
      for k=maxk,w.kmin,-1 do
        calls=calls+1
        if calls>5000000 then stop=true stopmsg='guard 5M calls' break end
        if w.line.can_insert_at(k/256) then
          local gb=gstats(g) local ab=gtotal() local pre=snap()
          w.line.insert_at(k/256,{name=slot.n,quality=slot.q,count=slot.ct},slot.ct)
          local ga=gstats(g) local aa=gtotal()
          local gd=ga-gb local ad=aa-ab
          if gd==slot.ct and ad==slot.ct then placed=placed+gd done=true break
          elseif gd==0 and ad==0 then misses=misses+1
          elseif gd==0 and ad==slot.ct then
            local post=snap()
            local rem=0
            for i2,d in ipairs(dlines) do if post[i2]>pre[i2] then
              rem=rem+d.line.remove_item({name=slot.n,count=post[i2]-pre[i2]})
              local rt=string.format('%d:%d->%d:%d',w.ord,w.li,d.ord,d.li)
              leak_routes[rt]=(leak_routes[rt] or 0)+1
            end end
            if gtotal()~=ab then stop=true stopmsg='leak undo failed' break end
            leaks_undone=leaks_undone+1
            if w.leakout==nil then w.leakout=0 end w.leakout=w.leakout+1
            if w.leakout>3 then break end
          else
            stop=true stopmsg=string.format('ANOMALY g=%d slot=%d win=%d k=%d gdelta=%d adelta=%d',gi,si,wj,k,gd,ad) break
          end
        end
      end
      if done or stop then break end
    end
    if stop then break end
    if not done then unplaced=unplaced+slot.ct stop=true stopmsg=string.format('UNPLACED g=%d slot=%d n=%s ct=%d placed_so_far=%d',gi,si,slot.n,slot.ct,placed) break end
  end
end
out.placed=placed out.misses=misses out.calls=calls out.leaks_undone=leaks_undone out.unplaced=unplaced out.stop=stopmsg
local lr={} for k,v in pairs(leak_routes) do lr[#lr+1]=k..' x'..v end
out.leak_routes=lr
local vsum={} local all_ok=true local purity_ok=true local pure_sides=0
for gi,g in ipairs(sgroups) do
  local exp=0 local expnames=0 local expname=nil
  for nm,v in pairs(g.expected) do exp=exp+v expnames=expnames+1 expname=nm end
  local tot,sl=gstats(g)
  local okc=(tot==exp and sl==#g.slots)
  local pure=''
  if expnames==1 and exp>0 then
    pure_sides=pure_sides+1
    local an=gnames(g) local extra=0
    for nm,v in pairs(an) do if nm~=expname then extra=extra+v end end
    if extra>0 then purity_ok=false pure=' PURITY-VIOLATION +'..extra else pure=' PURE('..expname..')' end
  end
  if not okc then all_ok=false end
  if exp>0 or tot>0 then vsum[#vsum+1]=string.format('side g%d wins=%d expected=%d actual=%d slots=%d/%d %s%s',gi,#g.wins,exp,tot,sl,#g.slots,okc and 'OK' or 'DIFF',pure) end
end
out.verify=vsum out.pure_sides=pure_sides out.purity_ok=purity_ok
local names={}
for nm,_ in pairs(totals) do names[#names+1]=nm end
local cname={} local sname={}
for _,nm in ipairs(names) do
  local c=0 for _,e in ipairs(dstE) do c=c+e.get_item_count(nm) end cname[nm]=c
  local sc=0 for _,e in ipairs(srcE) do sc=sc+e.get_item_count(nm) end sname[nm]=sc
end
out.clone_by_name=cname out.source_by_name=sname
local totals_ok=true local ctot=0
for _,nm in ipairs(names) do ctot=ctot+cname[nm] if cname[nm]~=totals[nm] then totals_ok=false end end
local pass=(not stopmsg) and all_ok and purity_ok and unplaced==0 and totals_ok and placed==ctot
out.pass=pass or false
out.success=true
end) if not ok then out.error=tostring(err) end rcon.print(helpers.table_to_json(out))
