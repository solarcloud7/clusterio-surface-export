local KEY="surface_export_manual_performance"
local ROOT="__level__/modules/surface_export/"
return function(action,name,mode,extra)
  assert(name:match("^transfer%-cleanup%-se%-manual%-"),"disposable fixture name required")
  assert(mode=="off" or mode=="normal" or mode=="debug","unknown profiling mode")
  if action=="grow" then
    assert(extra==0 or extra==512,"fixed size contract")
    local platform
    for _,p in pairs(game.forces.player.platforms) do if p.name==name then assert(not platform);platform=p end end
    assert(platform)
    local tiles={}
    for x=16,79 do for y=0,33 do tiles[#tiles+1]={name="space-platform-foundation",position={x,y}} end end
    if extra>0 then platform.surface.set_tiles(tiles) end
    for n=1,extra do
      local x=16+((n-1)%32)*2;local y=math.floor((n-1)/32)*2
      local chest=assert(platform.surface.create_entity{name="steel-chest",position={x,y},force="player"})
      assert(chest.insert{name="iron-plate",quality="rare",count=170}==170)
      assert(chest.insert{name="copper-plate",count=230}==230)
    end
    return {success=true}
  end
  local state=package.loaded[KEY]
  if action=="arm" then
    assert(not state,"profiler already installed")
    assert(table_size(storage.async_jobs or {})==0,"jobs active")
    state={name=name,records={},originals={},config=storage.surface_export_config.profile_batches}
    package.loaded[KEY]=state
    storage.surface_export_config.profile_batches=mode=="debug"
    local function replace(module,key,fn)
      state.originals[#state.originals+1]={module=module,key=key,fn=module[key]};module[key]=fn
    end
    if mode=="off" then
      local timing=assert(package.loaded[ROOT.."utils/operation-timing.lua"])
      for key,fn in pairs(timing) do if type(fn)=="function" then
        replace(timing,key,key=="scope" and function(_,_,work,...) return work(...) end or function() end)
      end end
    end
    for _,spec in ipairs({{"core/async-processor.lua","process_tick","scheduler"},
      {"core/export-pipeline.lua","queue","export_setup"},{"core/import-pipeline.lua","queue","import_setup"}}) do
      local module=assert(package.loaded[ROOT..spec[1]]);local original=assert(module[spec[2]])
      replace(module,spec[2],function(...)
        local relevant=spec[3]~="scheduler"
        if not relevant then for _,job in pairs(storage.async_jobs or {}) do if job.platform_name==name then relevant=true end end end
        if not relevant then return original(...) end
        if #state.records>=2000 then state.truncated=true;return original(...) end
        local profiler=helpers.create_profiler();local tick=game.tick
        local results=table.pack(pcall(original,...));profiler.stop()
        state.records[#state.records+1]={boundary=spec[3],startTick=tick,endTick=game.tick,reading=profiler,success=results[1]}
        if not results[1] then error(results[2],0) end
        return table.unpack(results,2,results.n)
      end)
    end
    return {success=true}
  end
  assert(action=="disarm" and state and state.name==name,"wrong profiler owner")
  for i=#state.originals,1,-1 do local r=state.originals[i];r.module[r.key]=r.fn end
  storage.surface_export_config.profile_batches=state.config
  package.loaded[KEY]=nil
  for _,r in ipairs(state.records) do
    rcon.print({"","[SE_MANUAL_PROFILE]",helpers.table_to_json{boundary=r.boundary,startTick=r.startTick,endTick=r.endTick,success=r.success},"\t",r.reading})
  end
  return {success=true,count=#state.records,truncated=state.truncated==true}
end
