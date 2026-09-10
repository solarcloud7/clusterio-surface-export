-- Codec-only experiment. No entities, surfaces, transfer jobs or event hooks.
local KEY='surface_export_codec_scaling_lab'
local function equal(a,b)
  if type(a)~=type(b) then return false end
  if type(a)~='table' then return a==b end
  for k,v in pairs(a) do if not equal(v,b[k]) then return false end end
  for k in pairs(b) do if a[k]==nil then return false end end
  return true
end
local function measured(label,fn)
  local p=helpers.create_profiler()
  local value=fn()
  p.stop()
  rcon.print({'','[SE_CODEC_V1]',label,'\t',p})
  return value
end
local invoke
invoke=function(action,id,arg)
  assert(id:match('^codecscale%-%w+$'),'owned ID required')
  local s=package.loaded[KEY]
  if action=='cleanup' then
    if not s then return {success=true,removed=true} end
    assert(s.id==id,'foreign lab state')
    package.loaded[KEY]=nil
    assert(storage.platform_exports[s.export_id].payload==s.cached,'source cache changed')
    return {success=true,removed=true,sourcePayloadUnchanged=true}
  end
  if action=='status' then return {success=true,present=s~=nil} end
  assert(#game.connected_players==0 and not game.tick_paused,'unoccupied running host required')
  assert(table_size(storage.async_jobs or {})==0 and table_size(storage.locked_platforms or {})==0
    and table_size(storage.destination_holds or {})==0,'active transfer work')
  if action=='prepare' then
    assert(not s,'another codec lab exists')
    assert(script.active_mods.base=='2.1.17')
    local cached=assert(storage.platform_exports[arg.export_id],'export missing').payload
    assert(type(cached)=='string' and #cached<200000)
    s={id=id,invoke=invoke,export_id=arg.export_id,cached=cached,ranges=arg.ranges}
    package.loaded[KEY]=s
    s.json=assert(helpers.decode_string(cached));assert(#s.json<=4000000)
    s.expected=assert(helpers.json_to_table(s.json))
    s.metadata={}
    for k,v in pairs(s.expected) do
      if k~='entities' and k~='tiles' and k~='belt_side_groups' then s.metadata[k]=v end
    end
    assert(#s.ranges>0 and #s.ranges<100)
    return {success=true,engine=script.active_mods.base,mods=script.active_mods,bytes=#s.json,framesPerCopy=#s.ranges+1}
  end
  assert(s and s.id==id,'lab absent or foreign')
  if action=='begin' then
    assert(arg.scale==1 or arg.scale==2 or arg.scale==4)
    s.scale=arg.scale;s.result={copies={}};s.cursor=1;s.previous_emit=nil;s.previous_consume=nil
    local copies={};for i=1,s.scale do copies[i]=s.json end
    s.monolith='{"copies":['..table.concat(copies,',')..']}'
    s.compressed=nil
    return {success=true,jsonBytes=#s.monolith,frames=(#s.ranges+1)*s.scale}
  end
  if action=='compress_full' then
    s.compressed=measured('factorio_compress',function() return assert(helpers.encode_string(s.monolith)) end)
    return {success=true,tick=game.tick,encodedBytes=#s.compressed}
  end
  if action=='decode_full' then
    local result=measured('full_decode',function()
      local json=assert(helpers.decode_string(s.compressed))
      return assert(helpers.json_to_table(json))
    end)
    assert(#result.copies==s.scale)
    for _,copy in ipairs(result.copies) do assert(equal(copy,s.expected),'full payload differs') end
    return {success=true,tick=game.tick,exactPayload=true}
  end
  if action=='emit' then
    if s.previous_emit==game.tick then return {success=true,waiting=true} end
    s.previous_emit=game.tick
    assert(arg==s.cursor,'unexpected source sequence')
    local per_copy=#s.ranges+1
    local copy=math.floor((arg-1)/per_copy)+1;local index=(arg-1)%per_copy
    assert(copy<=s.scale)
    local json=measured('source_encode',function()
      local frame={v=1,seq=arg,copy=copy}
      if index==0 then frame.kind='metadata';frame.data=s.metadata
      else
        local range=s.ranges[index];frame.kind='array';frame.key=range.key;frame.first=range.first
        assert(range.key=='entities' or range.key=='tiles' or range.key=='belt_side_groups')
        frame.data={};for i=range.first,range.last do frame.data[#frame.data+1]=assert(s.expected[range.key][i]) end
      end
      return helpers.table_to_json(frame)
    end)
    assert(#json<=65536,'frame size limit exceeded')
    s.cursor=s.cursor+1
    return {success=true,tick=game.tick,seq=arg,json=json,bytes=#json}
  end
  if action=='consume' then
    if s.previous_consume==game.tick then return {success=true,waiting=true} end
    s.previous_consume=game.tick
    assert(type(arg)=='string' and #arg<=100000)
    local frame
    measured('destination_decode',function()
      local json=assert(helpers.decode_string(arg),'external deflate incompatible')
      assert(#json<=65536,'decoded frame oversized')
      frame=assert(helpers.json_to_table(json))
      assert(frame.v==1 and frame.seq==(s.received or 0)+1 and frame.copy<=s.scale)
      if frame.kind=='metadata' then
        assert(s.result.copies[frame.copy]==nil);s.result.copies[frame.copy]=frame.data
      else
        assert(frame.kind=='array');local copy=assert(s.result.copies[frame.copy])
        local target=copy[frame.key] or {};copy[frame.key]=target
        assert(frame.first==#target+1,'missing or duplicated array range')
        for _,v in ipairs(frame.data) do target[#target+1]=v end
      end
      s.received=frame.seq
    end)
    return {success=true,tick=game.tick,seq=frame.seq}
  end
  if action=='reset_receiver' then s.result={copies={}};s.received=0;return {success=true} end
  if action=='verify' then
    assert(s.received==(#s.ranges+1)*s.scale and #s.result.copies==s.scale)
    for _,copy in ipairs(s.result.copies) do assert(equal(copy,s.expected),'sectional payload differs') end
    return {success=true,exactPayload=true,copies=s.scale}
  end
  if action=='gzip_shape' then
    local ok,value=pcall(helpers.decode_string,arg)
    return {success=true,accepted=ok and value=='codec-shape',returned=type(value),error=not ok and tostring(value) or nil}
  end
  error('unknown action')
end
return invoke
