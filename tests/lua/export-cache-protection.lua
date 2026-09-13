local root = "docker/seed-data/external_plugins/surface_export/module/"
local function fixture()
    local env = setmetatable({storage = {surface_export_config = {max_export_cache_size = 1},
        locked_platforms = {[1] = {transfer_job_id = "pending"}, [2] = {committed_transfer_id = "committed"}},
        platform_exports = {pending = {cache_seq = 1}, committed = {cache_seq = 2},
            old = {cache_seq = 3}, newest = {cache_seq = 4}}}, log = function() end}, {__index = _G})
    local prune = assert(loadfile(root .. "interfaces/remote/clear-old-exports.lua", "t", env))()
    env.require = function() return prune end
    local cache = assert(loadfile(root .. "utils/export-cache.lua", "t", env))()
    return env, prune, cache
end
for _, automatic in ipairs({false, true}) do
    local env, prune, cache = fixture()
    cache.set_concurrency(1)
    if automatic then cache.prune_to_configured_cap() else prune(1) end
    assert(env.storage.platform_exports.pending, "cleanup removed an active transfer export")
    assert(env.storage.platform_exports.committed, "cleanup removed a committed transfer export")
    assert(env.storage.platform_exports.newest)
    env.storage.locked_platforms = {}
    prune(1)
    assert(not env.storage.platform_exports.pending and not env.storage.platform_exports.committed)
end
local env, prune = fixture()
for _, count in ipairs({-1, 0.5, math.huge, 0/0, "1", false}) do
    assert(not pcall(prune, count), "accepted invalid retention limit")
    assert(env.storage.platform_exports.old, "invalid limit mutated the cache")
end
prune(0, nil, {pending = false})
assert(env.storage.platform_exports.pending and env.storage.platform_exports.committed, "caller bypassed protection")
assert(not env.storage.platform_exports.newest)
local isolated = {pending = {tick = 1}, newer = {tick = 2}}
prune(1, isolated)
assert(not isolated.pending and isolated.newer, "live locks affected an unrelated test cache")
for _, value in ipairs({-1, 0, 10.5, math.huge, 0/0, "1", false}) do
    local current, _, cache = fixture()
    assert(not pcall(cache.set_cap, value), "invalid configured cache cap accepted")
    assert(current.storage.surface_export_config.max_export_cache_size == 1, "invalid configuration changed saved cap")
    current.storage.surface_export_config.max_export_cache_size = value
    assert(pcall(cache.prune_to_configured_cap), "legacy invalid cap interrupted export completion")
    assert(current.storage.surface_export_config.max_export_cache_size == 10, "legacy invalid cap not repaired")
end
print("PASS automatic/manual pruning preserves transfer-owned exports; limits validate before mutation")
