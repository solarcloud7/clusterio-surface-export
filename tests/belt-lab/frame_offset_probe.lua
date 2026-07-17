-- BELT-R10 probe: insert_at write-frame offset, one tier per execution [empirical, 2.0.77]
-- Injected global (set EVERY call by run-r10-frame-offset.ps1 — RCON globals persist): TIER =
-- belt prototype name ('transport-belt' | 'fast-transport-belt' | 'express-transport-belt' |
-- 'turbo-transport-belt').
-- Three arms, all built, measured, and destroyed inside THIS single execution (no cross-call
-- state, no ticks elapse):
--   OFFSET    isolated single belt, insert_at(0.5) -> read back via get_detailed_contents;
--             law: read == 0.5 - belt_speed (exact to 1/512)
--   UNDERFLOW two-belt run A->B, write on A's line at one grid step below belt_speed*256;
--             law (fresh separate lines — they do NOT merge): ret=TRUE and the item lands
--             CLAMPED at read = max(0, write - belt_speed) on the same line; the historical
--             "materializes downstream" observable belongs to aged/merged-handle window
--             frames (the BELT-R11 leak class), not to this one-variable fixture
--   OVERFLOW  isolated single belt, write at line_length + 1/256; law: nothing placed
-- Scratch site: foundation at (-34..-20, 23..29) on lab-omnibus-platform-v1; everything created
-- here is destroyed before the execution returns.
-- No trailing '--' comments below (driver strips full-line comments, collapses newlines).
local out={success=false} local ok,err=pcall(function()
local p for _,q in pairs(game.forces.player.platforms) do if q.valid and q.name=='lab-omnibus-platform-v1' then p=q end end
if not p then out.abort='platform lab-omnibus-platform-v1 not found' return end
local s=p.surface local force=game.forces.player
if not TIER then out.abort='TIER not injected' return end
local clear=s.count_entities_filtered{area={{-34,23},{-20,29}}}
if clear>0 then out.abort='scratch site not clear: '..clear return end
local tiles={} for x=-34,-20 do for y=23,29 do tiles[#tiles+1]={name='space-platform-foundation',position={x,y}} end end
s.set_tiles(tiles)
local made={}
local function mk(x,y)
  local e=s.create_entity{name=TIER,position={x,y},direction=4,force=force}
  if e and e.valid then e.destructible=false made[#made+1]=e end
  return e
end
local speed=prototypes.entity[TIER].belt_speed
out.tier=TIER out.belt_speed=speed
local kmin=math.floor(speed*256+0.5)
local a=mk(-31.5,24.5)
local l=a.get_transport_line(1)
l.insert_at(0.5,{name='iron-plate',count=1},1)
local contents=l.get_detailed_contents()
if #contents~=1 then out.abort='offset arm: expected 1 item, got '..#contents return end
out.offset_read=contents[1].position
out.offset_expected=0.5-speed
out.offset_exact=(math.abs(contents[1].position-(0.5-speed))<(1/512))
local b1=mk(-31.5,26.5) local b2=mk(-30.5,26.5)
local lb=b1.get_transport_line(1)
local under_pos=(kmin-1)/256
lb.insert_at(under_pos,{name='iron-plate',count=1},1)
local seen={} local n=0 local read_pos=nil
for i,e in ipairs({b1,b2}) do
  for li=1,e.get_max_transport_line_index() do
    for _,it in ipairs(e.get_transport_line(li).get_detailed_contents()) do
      local uid=tostring(it.unique_id)
      if not seen[uid] then seen[uid]=true n=n+it.stack.count read_pos=it.position end
    end
  end
end
out.under_pos=under_pos out.under_count=n out.under_read_pos=read_pos
out.under_clamp_ok=(n==1 and read_pos~=nil and math.abs(read_pos-math.max(0,under_pos-speed))<(1/512))
local c=mk(-31.5,28.5)
local lc=c.get_transport_line(1)
local over_pos=lc.line_length+(1/256)
lc.insert_at(over_pos,{name='iron-plate',count=1},1)
local over_n=0
for li=1,c.get_max_transport_line_index() do
  for _,it in ipairs(c.get_transport_line(li).get_detailed_contents()) do over_n=over_n+it.stack.count end
end
out.over_pos=over_pos out.over_placed=over_n out.over_rejected=(over_n==0)
for _,e in ipairs(made) do if e.valid then e.destroy() end end
local leftover=s.count_entities_filtered{area={{-34,23},{-20,29}}}
out.cleanup_leftover=leftover
out.pass=(out.offset_exact and out.under_clamp_ok and out.over_rejected and leftover==0) or false
out.success=true
end) if not ok then out.error=tostring(err) end rcon.print(helpers.table_to_json(out))
