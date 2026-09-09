local root = "docker/seed-data/external_plugins/surface_export/module/"
local writes, encode_ok, write_ok = {}, true, true
local config = {}
local env = setmetatable({ storage = { surface_export_config = config }, game = {tick=100}, log=function()end,
  require=function() return {
    encode_json_compat=function(data) assert(encode_ok,"injected encode failure"); return "{}" end,
    write_file_compat=function(name) writes[#writes+1]=name; return write_ok,"injected write failure" end,
  } end,
}, {__index=_G})
local debug_export = assert(loadfile(root.."utils/debug-export.lua","t",env))()
assert(not debug_export.destination_snapshot_enabled())
config.debug_mode = true
assert(not debug_export.export_destination_platform({},"test"))
assert(#writes==0,"general debug must not write full destination snapshots")
assert(debug_export.export_import_result({},"test"))
assert(writes[1]:find("debug_import_result_",1,true),"compact result must remain available")
config.debug_destination_snapshot = true
assert(debug_export.export_destination_platform({},"test"))
assert(writes[2]:find("debug_destination_platform_",1,true))
config.debug_destination_snapshot = false
assert(not debug_export.export_destination_platform({},"test"))
config.debug_mode = false
config.debug_destination_snapshot = true
assert(not debug_export.destination_snapshot_enabled(),"full snapshots require debug mode too")
assert(debug_export.write_failure_black_box("test.json",{}),"failure evidence must ignore both debug switches")
config.debug_mode = true
encode_ok = false
local before = #writes
assert(not debug_export.export_destination_platform({},"test"))
assert(#writes==before,"failed encoding must not write a fake empty snapshot")
encode_ok,write_ok = true,false
assert(not debug_export.export_destination_platform({},"test"),"failed output must report failure")
print("PASS dedicated snapshot opt-in, compact results, independent failure evidence and output failures")
