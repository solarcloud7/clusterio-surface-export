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
      for _, evacuation in ipairs({"success", "failed", "throw", "missing"}) do
        local lock = {committed = committed}
        local platform = {valid = true, surface = {valid = true, index = 9}}
        local cleared, deleted, deleteCalls, notices = false, false, 0, {}
        local manifest, departCalls, departedNotices = {{name = "passenger", items = {}}}, 0, 0
        local env = setmetatable({storage = {locked_platforms = {[3] = lock}}, log = noop,
            game = {forces = {player = {platforms = {[3] = platform}}}, print = function(message)
                assert(deleted and cleared, "departure announced before deletion was confirmed")
                notices[#notices + 1] = message
                if committed then error("injected chat failure") end
            end}}, {__index = _G})
        local modules = {
            ["core/source-recovery"] = {matches = function(_, uid) return uid == "uid" end},
            ["utils/operation-timing"] = {begin = noop, finish = noop, scope = function(_, _, fn, ...) return fn(...) end},
            ["core/passenger-transit"] = {
                depart = function(job)
                    assert(committed and job == "job", "passengers departed before the source commit")
                    departCalls = departCalls + 1
                    return manifest
                end,
                settle = noop,
                notify_departed = function()
                    assert(deleted, "passengers notified before deletion")
                    departedNotices = departedNotices + 1
                end,
            },
            ["core/gateway"] = {evacuate_passengers = function()
                if evacuation == "throw" then error("injected evacuation failure") end
                if evacuation == "missing" then return nil end
                return {success = evacuation == "success", failures = evacuation == "success" and 0 or 1}
            end},
            ["utils/game-utils"] = {pcall_warn = function(_, fn) return fn() end, delete_platform = function()
                deleteCalls = deleteCalls + 1
                assert(env.storage.locked_platforms[3] == lock, "source unlocked before deletion")
                assert(not cleared, "published deletion before engine accepted it")
                if outcome == "throw" then error("injected delete exception") end
                if outcome == "false" then return false end
                deleted = true; platform.valid = false; return true
            end},
            ["utils/surface-lock"] = {
                commit_source_transfer_lock = function() committed = true; return true end,
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
        for _, missing in ipairs({false, "", 7}) do
            assert(remove(3, "fixture", "player", "job", missing):sub(1, 6) == "ERROR:")
        end
        assert(remove(3, "fixture", "player", "job", nil):sub(1, 6) == "ERROR:")
        assert(deleteCalls == 0, "missing retirement identity reached the engine")
        assert(remove(3, "fixture", "player", "job", "other-uid"):sub(1, 6) == "ERROR:")
        assert(deleteCalls == 0, "mismatched retirement identity reached the engine")
        local result = remove(3, "fixture", "player", "job", "uid")
        if evacuation ~= "success" then
            assert(result:sub(1, 6) == "ERROR:" and deleteCalls == 0,
                "source deleted after " .. evacuation .. " evacuation")
            assert(env.storage.locked_platforms[3] == lock and not cleared,
                "evacuation failure lost source protections")
            assert(not modules["utils/transfer-receipts"].get("source_deleted", "job"), "false deletion receipt")
            assert(#notices == 0, "failed evacuation announced departure")
            evacuation = "success"
            result = remove(3, "fixture", "player", "job", "uid")
        end
        if outcome == "success" then
            assert(result == "SUCCESS" and not env.storage.locked_platforms[3])
            assert(cleared == committed)
            assert(remove(3, "renamed fixture", "player", "job", "uid") == "SUCCESS", "lost deletion reply cannot be retried")
            assert(remove(3, "fixture", "player", "job", "other-uid"):sub(1, 6) == "ERROR:", "receipt accepted a different UID")
            assert(deleteCalls == 1, "duplicate source deletion executed twice")
            local receipt = modules["utils/transfer-receipts"].get("source_deleted", "job")
            assert(receipt.passengers == manifest, "source deletion receipt lost the passenger manifest")
            assert(departedNotices == 1, "passenger departure notice was duplicated or missing")
            assert(#notices == 1 and notices[1] == "Platform 'fixture' departed.", "departure was duplicated or missing")
            platform.valid = true
            assert(remove(3, "fixture", "player", "job", "uid"):sub(1, 6) == "ERROR:", "receipt accepted a present platform")
            platform.valid = false
            assert(remove(4, "fixture", "player", "job", "uid"):sub(1, 6) == "ERROR:", "receipt accepted a different index")
        else
            assert(result:sub(1, 6) == "ERROR:" and env.storage.locked_platforms[3] == lock and not cleared)
            assert(#notices == 0, "failed deletion announced departure")
            assert(departedNotices == 0, "failed deletion notified passengers")
        end
      end
    end
end
print("PASS source lock survives evacuation/deletion failure; retry and replay publish one confirmed deletion")
