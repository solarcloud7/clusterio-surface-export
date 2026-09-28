local root = "docker/seed-data/external_plugins/surface_export/module/"
local json = assert(loadfile(root .. "core/json.lua"))()
local input = json.decode(io.read("*a"))
local function noop() end
local env = setmetatable({game = {tick = 1, print = noop, forces = {}}, log = noop,
    storage = {async_jobs = {}, async_job_results = {}, async_job_id_counter = 0, source_recovery_ready = true},
    helpers = {decode_string = function(raw) return assert(input.decoded[raw], "undecoded payload") end,
        json_to_table = function(text) local ok, value = pcall(json.decode, text); if ok then return value end end}},
    {__index = _G})
local stub = setmetatable({}, {__index = function() return noop end})
local real = {["core/import-pipeline"] = true, ["utils/section-codec"] = true, ["utils/json-compat"] = true,
    ["utils/table-utils"] = true, ["utils/platform-lineage"] = true}
local modules = {
    ["utils/operation-timing"] = setmetatable({scope = function(_, _, fn, ...) return fn(...) end}, {__index = function() return noop end}),
    ["utils/version-compat"] = {parse = function() return {bucket = "test"} end, runtime_bucket = function() return "test" end,
        migrate = function(value) return value end, check_payload_schema = function() return true end},
    ["utils/platform-schedule"] = {validate_transfer_payload = function() return true end},
    ["utils/util"] = {json_to_table_compat = function(text) return env.helpers.json_to_table(text) end},
}
env.require = function(path)
    local name = path:match("^modules/surface_export/(.*)$")
    if not name then return stub end
    if not modules[name] then modules[name] = real[name] and assert(loadfile(root .. name .. ".lua", "t", env))() or stub end
    return modules[name]
end
local lineage = env.require("modules/surface_export/utils/platform-lineage")
local pipeline = env.require("modules/surface_export/core/import-pipeline")
local observed
local carry = lineage.transfer_carry
lineage.transfer_carry = function(data)
    local value, generation, err = carry(data)
    observed = {lineage = value, generation = generation, error = err, transfer_id = data._transferId, standalone = data._standaloneImport}
    return value, generation, err
end
local function queue(...)
    local ok, id, err = pcall(pipeline.queue, ...)
    if ok then return id, err end
    assert(observed, "the import pipeline failed before the lineage carry: " .. tostring(id))
    return nil, "stopped after the lineage carry: " .. tostring(id)
end
local id, err = queue(input.transport, "carried", "player", "RCON")
local pending = id and env.storage.async_jobs[id]
if pending and pending.section_decoder then
    while not pending.decoded_data do pipeline.process_setup(pending) end
    id, err = queue(pending.decoded_data, "carried", "player", "RCON", nil, pending)
end
assert(observed, "the import pipeline never reached the lineage carry: " .. tostring(err))
local hold = observed.lineage and lineage.hold_carry({lineage = observed.lineage, lineage_generation = observed.generation,
    transfer_id = observed.transfer_id, platform_data = {_standaloneImport = observed.standalone}})
print(string.format("CARRY %s %s %s %s %s", tostring(observed.lineage), tostring(observed.generation),
    tostring(hold and hold.lineage), tostring(hold and hold.generation), tostring(observed.error)))
