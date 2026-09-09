-- Execute the real source-delete handler with a failing engine boundary.
local root = "docker/seed-data/external_plugins/surface_export/module/"
local function noop() end
-- Neither adapter may turn the engine's false return into a successful deletion.
for _, accepted in ipairs({false, true}) do
    local env = setmetatable({game = {delete_surface = function() return accepted end},
        script = {active_mods = {base = "2.1.17"}}, log = noop}, {__index = _G})
    local compat = assert(loadfile(root .. "utils/version-compat.lua", "t", env))()
    env.require = function() return compat end
    local utils = assert(loadfile(root .. "utils/game-utils.lua", "t", env))()
    assert(utils.delete_platform({valid = true, surface = {valid = true}}) == accepted,
        "engine deletion refusal was converted to success")
end
for _, committed in ipairs({false, true}) do
    for _, outcome in ipairs({"throw", "false", "success"}) do
        local lock = {committed = committed}
        local platform = {valid = true, surface = {valid = true, index = 9}}
        local cleared, deleted, deleteCalls = false, false, 0
        local env = setmetatable({storage = {locked_platforms = {[3] = lock}},
            game = {forces = {player = {platforms = {[3] = platform}}}, print = noop}}, {__index = _G})
        local modules = {
            ["utils/operation-timing"] = {begin = noop, finish = noop, scope = function(_, _, fn, ...) return fn(...) end},
            ["core/gateway"] = {evacuate_passengers = noop},
            ["utils/game-utils"] = {pcall_warn = function(_, fn) return fn() end, delete_platform = function()
                deleteCalls = deleteCalls + 1
                assert(env.storage.locked_platforms[3] == lock, "source unlocked before deletion")
                assert(not cleared, "published deletion before engine accepted it")
                if outcome == "throw" then error("injected delete exception") end
                if outcome == "false" then return false end
                deleted = true; platform.valid = false; return true
            end},
            ["utils/surface-lock"] = {
                get_lock_data = function() return lock end,
                transfer_delete_identity_ok = function() return true end,
                source_lock_is_committed = function() return committed end,
                unlock_platform = function() error("deletion must never reactivate source") end,
                clear_committed_source_lock_after_delete = function()
                    assert(deleted, "tombstone published too early")
                    cleared = true; env.storage.locked_platforms[3] = nil; return true
                end,
            },
        }
        modules["utils/transfer-receipts"] = assert(loadfile(root .. "utils/transfer-receipts.lua", "t", env))()
        env.require = function(name) return assert(modules[name:gsub("^modules/surface_export/", "")], name) end
        local remove = assert(loadfile(root .. "interfaces/remote/delete-platform-for-transfer.lua", "t", env))()
        for _, missing in ipairs({false, "", 7}) do
            assert(remove(3, "fixture", "player", missing):sub(1, 6) == "ERROR:")
        end
        assert(remove(3, "fixture", "player", nil):sub(1, 6) == "ERROR:")
        assert(deleteCalls == 0, "unidentified deletion reached the engine")
        local result = remove(3, "fixture", "player", "job")
        if outcome == "success" then
            assert(result == "SUCCESS" and not env.storage.locked_platforms[3])
            assert(cleared == committed)
            assert(remove(3, "renamed fixture", "player", "job") == "SUCCESS", "lost deletion reply cannot be retried")
            assert(deleteCalls == 1, "duplicate source deletion executed twice")
            platform.valid = true
            assert(remove(3, "fixture", "player", "job"):sub(1, 6) == "ERROR:", "receipt accepted a present platform")
            platform.valid = false
            assert(remove(4, "fixture", "player", "job"):sub(1, 6) == "ERROR:", "receipt accepted a different index")
        else
            assert(result:sub(1, 6) == "ERROR:" and env.storage.locked_platforms[3] == lock and not cleared)
        end
    end
end
print("PASS source lock survives refused/thrown deletion; committed tombstone follows accepted deletion")
