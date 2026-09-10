local calls={}
local function noop() end
local env=setmetatable({storage={},game={tick=100},log=noop},{__index=_G})
env.require=function(path)
  if path:find('async%-processor') then return {queue_import=function(data,name,force,requester,timing)
    calls[#calls+1]={data=data,operation=timing.operation_id,name=name,force=force};return 'job'..#calls
  end} end
  return setmetatable({scope=function(_,_,fn,...) return fn(...) end},{__index=function() return noop end})
end
local load=assert(loadfile('docker/seed-data/external_plugins/surface_export/module/interfaces/remote/import-platform-chunk.lua','t',env))
local receive=load()
assert(receive('Same name','A',1,3,'player','operation-A')=='CHUNK_OK:1/3')
assert(receive('Same name','X',1,3,'player','operation-B')=='CHUNK_OK:1/3')
assert(receive('Same name','A',1,3,'player','operation-A')=='CHUNK_OK:1/3','identical chunk retry changed progress')
assert(receive('Same name','wrong',1,3,'player','operation-A'):match('^ERROR:'),'conflicting retry accepted')
assert(receive('Different name','B',2,3,'player','operation-A'):match('^ERROR:'),'operation metadata changed')
assert(receive('Same name','B',2,4,'player','operation-A'):match('^ERROR:'),'chunk count changed')
receive('Same name','B',2,3,'player','operation-A')
receive('Same name','Y',2,3,'player','operation-B')
receive('Same name','C',3,3,'player','operation-A')
receive('Same name','Z',3,3,'player','operation-B')
assert(#calls==2,'interleaved imports did not queue exactly once each')
assert(calls[1].data=='ABC' and calls[1].operation=='operation-A','chunks crossed operation ownership')
assert(calls[2].data=='XYZ' and calls[2].operation=='operation-B','second payload corrupted')
print('PASS same-name chunk uploads retain independent operation ownership')
