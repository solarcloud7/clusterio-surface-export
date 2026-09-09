local PREFIX = "transfer-cleanup-"
local MODULE = "__level__/modules/surface_export/utils/game-utils.lua"
local LOCK = "__level__/modules/surface_export/utils/surface-lock.lua"
local HOOK = "surface_export_cleanup_test_hook"

local function find(name)
  local found
  for _, p in pairs(game.forces.player.platforms) do
    if p.valid and p.name == name then
      assert(not found, "ambiguous fixture name")
      found = p
    end
  end
  return found
end

local function quantities(contents)
  local result = {}
  for _, item in pairs(contents) do
    local key = item.name .. "/" .. (item.quality or "normal")
    result[key] = (result[key] or 0) + item.count
  end
  return result
end

local function observe(name)
  local p = find(name)
  if not p then return {present=false, tick=game.tick} end
  local s = p.surface
  local inventory, lanes, fluids, entities = {}, {}, {}, {}
  local canary
  for _, e in pairs(s.find_entities_filtered{force="player"}) do
    local key = e.name .. "@" .. e.position.x .. "," .. e.position.y
    entities[#entities+1] = key
    for i=1,e.get_max_inventory_index() do
      local inv = e.get_inventory(i)
      if inv and inv.valid then inventory[key .. ":" .. i] = quantities(inv.get_contents()) end
    end
    if e.type == "transport-belt" then
      for side=1,2 do lanes[key .. ":" .. side] = quantities(e.get_transport_line(side).get_contents()) end
    elseif e.type == "storage-tank" then
      local fluid = e.get_fluid(1)
      fluids[key] = fluid and {name=fluid.name,amount=fluid.amount,temperature=fluid.temperature} or {}
    elseif e.name == "assembling-machine-1" then
      assert(not canary, "multiple canaries")
      canary = {active=e.active, disabled=e.disabled_by_script}
    end
  end
  table.sort(entities)
  assert(canary, "missing activation canary")
  local held = false
  for _, hold in pairs(storage.destination_holds or {}) do
    if hold.surface_index == s.index then held = true end
  end
  local lock = (storage.locked_platforms or {})[p.index]
  local hidden = game.forces.player.get_surface_hidden(s)
  return {present=true,tick=game.tick,index=p.index,surface=s.index,
    platformHidden=p.hidden,surfaceHidden=hidden,travelPaused=p.paused,
    canary=canary,locked=lock~=nil,lockPhase=lock and lock.phase,held=held,
    usable=not p.hidden and not hidden and canary.active and not canary.disabled and not lock and not held,
    cargo={inventories=inventory,lanes=lanes,fluids=fluids,entities=entities}}
end

return function(action, name)
  assert(type(name)=="string" and name:sub(1,#PREFIX)==PREFIX and name:match("^[%w-]+$"), "invalid fixture scope")
  if action == "world" then
    local world = {}
    for _, p in pairs(game.forces.player.platforms) do
      world[#world+1] = {index=p.index,surface=p.surface.index,name=p.name}
      assert(p.name:sub(1,#PREFIX)~=PREFIX, "foreign or stale cleanup-test fixture")
    end
    table.sort(world,function(a,b) return a.index<b.index end)
    assert(not package.loaded[HOOK], "foreign fault hook")
    return {success=true,world=world,engine=script.active_mods.base,mods=script.active_mods,
      module=remote.call("surface_export","get_module_version")}
  elseif action == "build" or action == "build-empty" or action == "build-large" then
    assert(not find(name), "fixture already exists")
    local p = assert(game.forces.player.create_space_platform{name=name,planet="nauvis",starter_pack="space-platform-starter-pack"})
    p.apply_starter_pack()
    p.paused=true
    p.hidden=false
    game.forces.player.set_surface_hidden(p.surface,false)
    local tiles={}
    for x=-12,12 do for y=-8,8 do tiles[#tiles+1]={name="space-platform-foundation",position={x,y}} end end
    p.surface.set_tiles(tiles)
    if action == "build-large" then
      -- Bounded scale fixture; ordinary inert cargo avoids production consumption.
      for x=-64,63 do
        local row={}
        for y=-64,63 do row[#row+1]={name="space-platform-foundation",position={x,y}} end
        p.surface.set_tiles(row)
      end
    end
    if action == "build-empty" then
      for i=1,p.hub.get_max_inventory_index() do
        local inv=p.hub.get_inventory(i)
        if inv then inv.clear() end
      end
    end
    local function create(proto,x,y)
      return assert(p.surface.create_entity{name=proto,position={x,y},force="player",direction=defines.direction.north})
    end
    local chest=create("steel-chest",8,4)
    assert(chest.insert{name="iron-plate",quality="rare",count=17}==17)
    assert(chest.insert{name="copper-plate",count=23}==23)
    local tank=create("storage-tank",-8,0)
    assert(tank.set_fluid(1,{name="water",amount=123,temperature=15})==123)
    create("assembling-machine-1",8,0).disabled_by_script=false
    for n,x in ipairs({-8,-6}) do
      local belt=create("transport-belt",x,5)
      assert(belt.get_transport_line(1).insert_at_back{name="iron-plate",quality=n==1 and "normal" or "rare"})
      assert(belt.get_transport_line(2).insert_at_back{name="copper-plate",quality=n==1 and "rare" or "normal"})
    end
    if action == "build-large" then
      for x=16,35 do for y=16,35 do
        local c=create("steel-chest",x,y)
        local inv=c.get_inventory(defines.inventory.chest)
        assert(#inv==48, "large fixture requires 48-slot steel chests")
        for slot=1,#inv do
          assert(inv[slot].set_stack{name="iron-plate",count=slot,quality="rare"})
        end
      end end
      for x=-60,-41 do for y=16,35 do
        local b=create("transport-belt",x,y*2-32)
        assert(b.get_transport_line(1).insert_at_back{name="iron-plate"})
        assert(b.get_transport_line(2).insert_at_back{name="copper-plate",quality="rare"})
      end end
    end
    return {success=true,state=observe(name)}
  elseif action == "arm" then
    assert(not package.loaded[HOOK], "fault hook already armed")
    local p=assert(find(name), "fixture missing")
    local utils=assert(package.loaded[MODULE], "GameUtils not loaded")
    local hook={name=name,surface=p.surface.index,index=p.index,original=utils.delete_platform,calls={}}
    hook.wrapper=function(candidate)
      if candidate and candidate.valid and candidate.index==hook.index and candidate.surface.index==hook.surface then
        hook.calls[#hook.calls+1]=observe(name)
        error("TEST source deletion rejected before mutation: " .. name)
      end
      return hook.original(candidate)
    end
    package.loaded[HOOK]=hook
    utils.delete_platform=hook.wrapper
    return {success=true}
  elseif action == "fault" or action == "disarm" then
    local hook=package.loaded[HOOK]
    if not hook then return {success=true,armed=false,calls={}} end
    assert(hook.name==name,"refuse foreign hook")
    local utils=assert(package.loaded[MODULE])
    assert(utils.delete_platform==hook.wrapper,"fault function replaced by another owner")
    if action=="disarm" then utils.delete_platform=hook.original;package.loaded[HOOK]=nil end
    return {success=true,armed=action~="disarm",calls=hook.calls}
  elseif action == "exists" then
    return {success=true,present=find(name)~=nil}
  elseif action == "read" then
    return {success=true,state=observe(name)}
  elseif action == "tiles" then
    local p=assert(find(name), "fixture missing")
    local result={}
    for _, t in pairs(p.surface.find_tiles_filtered{name={"empty-space","out-of-map"},invert=true}) do
      result[#result+1]=t.name .. "@" .. t.position.x .. "," .. t.position.y
    end
    assert(#result<=20000,"tile observation exceeds fixture bound")
    table.sort(result)
    return {success=true,tiles=result}
  elseif action == "unlock" then
    local p=assert(find(name), "fixture missing")
    local lock=assert((storage.locked_platforms or {})[p.index], "fixture lock missing")
    assert(lock.surface_index==p.surface.index, "lock identity mismatch")
    assert(package.loaded[LOCK].unlock_platform(p.index), "fixture unlock refused")
    return {success=true,state=observe(name)}
  elseif action == "cleanup" then
    assert(not package.loaded[HOOK],"disarm before cleanup")
    assert(table_size(storage.async_jobs or {})==0,"jobs still running")
    local p=find(name)
    if p then
      for _, player in pairs(game.players) do
        assert(player.surface.index~=p.surface.index,"player on fixture; refuse cleanup")
      end
      for id, hold in pairs(storage.destination_holds or {}) do
        if hold.surface_index==p.surface.index then
          assert(hold.platform_index==p.index,"hold identity mismatch")
          local holds=assert(package.loaded["__level__/modules/surface_export/core/destination-hold.lua"])
          assert(holds.discard(id),"owned hold discard refused")
          return {success=true,present=find(name)~=nil}
        end
      end
      local lock=(storage.locked_platforms or {})[p.index]
      if lock then
        assert(lock.surface_index==p.surface.index,"lock identity mismatch")
        assert(package.loaded[LOCK].unlock_platform(p.index),"fixture unlock refused")
      end
      assert(game.delete_surface(p.surface),"fixture deletion failed")
    end
    return {success=true,present=find(name)~=nil}
  end
  error("unknown action: " .. tostring(action))
end
