local receive=dofile("docker/seed-data/external_plugins/surface_export/module/interfaces/remote/import-platform-chunk.lua")
storage={chunked_imports={}}
assert(receive("Same name","A",1,3,"player","operation-A"):find("Unsupported upload protocol",1,true))
assert(next(storage.chunked_imports)==nil,"legacy callers cannot create upload buffers")
print("PASS: legacy upload protocol fails explicitly without allocating buffers")
