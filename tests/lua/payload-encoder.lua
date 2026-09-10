local root = "docker/seed-data/external_plugins/surface_export/module/"
local modules, sizes, fail = {}, {}, false
local env = setmetatable({log = function() end}, {__index = _G})
env.require = function(path)
    local name = path:match("^modules/surface_export/(.*)$")
    if not modules[name] then modules[name] = assert(loadfile(root .. name .. ".lua", "t", env))() end
    return modules[name]
end
local json = env.require("modules/surface_export/utils/json-compat")
local encode = json.encode_json_compat
json.encode_json_compat = function(value)
    if fail then return nil, "injected encoder failure" end
    sizes[#sizes + 1] = #value
    return encode(value)
end
local payload = {entities = {}, tiles = {}, label = 'quote" newline\n backslash\\', empty = {}, enabled = false}
for i = 1, 23 do payload.entities[i] = {id = i, quality = "rare", inventory = {{name = "iron-plate", count = i}}} end
for i = 1, 207 do payload.tiles[i] = {name = "modded-floor", position = {x = i, y = -i}} end
local original = json.to_json(payload)
local job = {export_data = payload}
local result
for tick = 1, 100 do
    -- All progress must survive module reload; no native handle is kept in state.
    modules["utils/payload-encoder"] = nil
    local module = env.require("modules/surface_export/utils/payload-encoder")
    result = module.process(job, 5)
    assert(json.to_json(payload) == original, "encoder mutated captured data")
    if result then break end
end
assert(result and not job.json_cursor, "encoding never completed")
-- Build the expected object with the same native-value encoder and sorted keys.
local keys, expected = {}, {}
for k in pairs(payload) do keys[#keys + 1] = k end; table.sort(keys)
for _, k in ipairs(keys) do expected[#expected + 1] = json.to_json(k) .. ":" .. json.to_json(payload[k]) end
assert(result == "{" .. table.concat(expected, ",") .. "}", "chunked JSON differs from whole value encoding")
for _, n in ipairs(sizes) do assert(n <= 100, "array batch exceeded bound") end
fail = true
assert(not pcall(env.require("modules/surface_export/utils/payload-encoder").process, {export_data = payload}, 5), "encoder failure reported success")
print("PASS chunked JSON parity, escaping, empty values, persisted progress, bounded arrays and encode failure")
