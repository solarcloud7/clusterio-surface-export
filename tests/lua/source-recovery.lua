local root = "docker/seed-data/external_plugins/surface_export/module/"
local force = {name = "player", platforms = {}}
local platform = {valid = true, index = 3, force = force, surface = {valid = true, index = 8},
    hub = {valid = true, unit_number = 15}}
force.platforms[3] = platform
local env = setmetatable({storage = {}, game = {forces = {player = force}}}, {__index = _G})
local locks = {}
env.storage.locked_platforms = locks
local lock_api = {
    get_lock_data = function(index) return locks[index] end,
    destination_hold_owns_surface = function() return false end,
    lock_platform = function(p, _, opts) locks[p.index] = {kind = opts.kind}; p.hidden = true; return true end,
    unlock_platform = function(index, _, bootstrap)
        assert(bootstrap, "bootstrap must explicitly own its unlock")
        locks[index] = nil; platform.hidden = false; return true
    end,
    commit_source_transfer_lock = function(index, id)
        assert(locks[index].transfer_job_id == id)
        locks[index].phase = "committed"; return true
    end,
    transfer_delete_identity_ok = function(lock, _, id)
        return lock and lock.kind == "transfer" and lock.transfer_job_id == id, "wrong transfer"
    end,
}
env.require = function() return lock_api end
local recovery = assert(loadfile(root .. "core/source-recovery.lua", "t", env))()
recovery.startup()
assert(platform.hidden and not env.storage.source_recovery_ready)
local boot = recovery.begin("boot-a", "journal-a", false)
assert(boot.success and boot.platforms[1].platformUid == "boot-a:15")
assert(recovery.reconcile(3, "boot-a:15", nil).success)
assert(recovery.finish().success and not platform.hidden)

-- Simulate loading the earlier checkpoint: saved identities survive, the runtime lock does not.
recovery.startup()
assert(platform.hidden, "restored source was usable before reconciliation")
assert(not recovery.begin("boot-b", "wrong-journal", true).success)
assert(platform.hidden, "foreign authority released a restored source")
assert(recovery.begin("boot-b", "journal-a", true).success)
assert(not recovery.reconcile(3, "foreign-platform", "job-a").success)
assert(recovery.reconcile(3, "boot-a:15", "job-a").quarantined)
assert(recovery.finish().success)
assert(platform.hidden and locks[3].phase == "committed")
assert(recovery.source_identity(3, "player", "job-a").platformUid == "boot-a:15")
assert(not recovery.source_identity(3, "player", "job-b").success)

-- Index reuse is a different identity, even if the platform name is reused.
locks[3] = nil
platform.hub.unit_number = 16
recovery.surface_created(platform.surface.index)
assert(not recovery.matches(platform, "boot-a:15"))
assert(recovery.matches(platform, "boot-b:16"))

-- A checkpoint predating identity tracking cannot be reconciled by index/name guessing.
env.storage.source_recovery_identities = {}
env.storage.source_recovery_surface_epochs = {}
recovery.startup()
assert(not recovery.begin("boot-c", "journal-a", true).success)
assert(platform.hidden and not env.storage.source_recovery_ready)
assert(not recovery.finish().success)
-- Factorio throws on member reads from invalid entity handles.
env.storage.source_recovery_identities[3] = {surface_index = 8, hub_unit_number = 16, uid = "boot-b:16"}
platform.hub = setmetatable({valid = false}, {__index = function() error("invalid LuaEntity read") end})
local valid_read, result = pcall(recovery.begin, "boot-d", "journal-a", true)
assert(valid_read and not result.success, "invalid hub crashed recovery instead of refusing")
print("PASS startup protection, retired identity quarantine, replay binding, and untracked-save refusal")

-- Startup must not perform transfer-only cargo preparation or wait for scheduler work
-- that is intentionally suspended until reconciliation finishes.
for _, pending in ipairs({false, true}) do
    local finished = 0
    local pod = {valid = true, type = "cargo-pod", cargo_pod_state = "ascending",
        force_finish_ascending = function() finished = finished + 1 end}
    local s = {valid = true, index = 8, find_entities_filtered = function() return {pod} end}
    local f = {name = "player", get_surface_hidden = function() return false end, set_surface_hidden = function() end}
    local p = {valid = true, name = "untouched", index = 3, surface = s, force = f, hidden = false}
    local e = setmetatable({storage = {}, game = {tick = 1, print = function() end}, log = function() end,
        require = function(name)
            if name:find("game-utils", 1, true) then return {ACTIVATABLE_ENTITY_TYPES = {}} end
            if name:find("platform-schedule", 1, true) then return {capture = function() return {} end} end
            if name:find("latch_rearm", 1, true) then return {pending_on_surface = function() return pending end} end
            error(name)
        end}, {__index = _G})
    local lock = assert(loadfile(root .. "utils/surface-lock.lua", "t", e))()
    assert(lock.lock_platform(p, f, {kind = "startup"}), "startup cannot await suspended latch work")
    assert(finished == 0, "ordinary startup force-finished an unrelated cargo pod")
end
print("PASS startup leaves cargo pods and pending circuit work alone")

platform.hub = {valid = true, unit_number = 16}
env.storage.source_recovery_identities[3] = {surface_index = 8, hub_unit_number = 16, uid = "boot-b:16"}
locks[3] = nil
lock_api.accept_restored_source = function(index, old_id)
    assert(index == 3 and old_id == "job-old")
    locks[index] = nil; platform.hidden = false; return true
end
recovery.startup()
assert(recovery.begin("boot-save", "journal-a", true, "save_game", true).success)
local accepted = recovery.reconcile(3, "boot-b:16", "job-old")
assert(accepted.accepted and not platform.hidden, "save-game policy did not accept the restored source")
assert(recovery.finish().success)
assert(not recovery.matches(platform, "boot-b:16"), "old identity can address an accepted restoration")
assert(recovery.matches(platform, accepted.platformUid), "new identity was not retained")
local first_id = recovery.export_job_id(1, "same-platform")
recovery.startup()
assert(recovery.begin("next-boot", "journal-a", true, "plugin_history", false).success)
assert(recovery.reconcile(3, accepted.platformUid, nil).success)
assert(recovery.finish().success)
assert(recovery.matches(platform, accepted.platformUid), "restart changed the accepted platform identity")
assert(recovery.export_job_id(1, "same-platform") ~= first_id, "old save reused an export operation ID")
recovery.startup()
assert(recovery.begin("blocked-boot", "journal-a", true, "save_game", false).success)
assert(recovery.reconcile(3, accepted.platformUid, "pending-job").quarantined)
assert(platform.hidden, "save-game mode released unresolved ownership")
print("PASS save-game adoption, persistent fresh identity, new export IDs, and unresolved ownership protection")

-- Exercise the real lock guard, not the reconciliation mock above.
local e = setmetatable({storage = {source_recovery_ready = true, locked_platforms = {}},
    require = function() return {ACTIVATABLE_ENTITY_TYPES = {}} end}, {__index = _G})
local real_lock = assert(loadfile(root .. "utils/surface-lock.lua", "t", e))()
local held = {kind = "transfer", phase = "committed", transfer_job_id = "old", platform_name = "fixture"}
e.storage.locked_platforms[3] = held
assert(not real_lock.unlock_platform(3), "normal unlock released a committed source")
assert(not real_lock.accept_restored_source(3, "old"), "adoption outside startup was authorized")
e.storage.source_recovery_ready = false
e.storage.source_recovery_mode = "save_game"
assert(not real_lock.accept_restored_source(3, "old"), "unresolved handoff was released")
e.storage.source_recovery_allow_adoption = true
assert(not real_lock.accept_restored_source(3, "foreign"), "another job bypassed the committed guard")
e.storage.source_recovery_ready = true
e.storage.source_recovery_notices = {[3] = {status = "accepted"}}
held.phase = "pre_commit"; held.transfer_job_id = "new"
assert(not real_lock.unlock_platform(3, nil, nil, nil, "old"), "delayed old unlock released the new transfer")
assert(not real_lock.unlock_platform(3), "unidentified unlock released an accepted restoration")
assert(e.storage.locked_platforms[3] == held, "rejected unlock mutated the lock")
print("PASS real committed lock and delayed unlock guards")

recovery.startup()
assert(recovery.begin("pending-boot", "journal-a", true, "save_game", true).success)
env.storage.async_jobs = {pending = {platform_index = 3}}
assert(recovery.reconcile(3, accepted.platformUid, "pending-job").quarantined,
    "controller history overrode a job still owned by the loaded save")
assert(platform.hidden)
print("PASS loaded Lua jobs retain ownership in Save game mode")

-- A rejected schedule must leave the old identity's protection intact.
do
    local f = {platforms = {}, set_surface_hidden = function() error("released hidden surface before schedule validation") end}
    local p = {valid = true, hidden = true, surface = {valid = true, index = 8}}
    f.platforms[3] = p
    local record = {kind = "transfer", phase = "committed", transfer_job_id = "old", force_name = "player",
        platform_index = 3, surface_index = 8, original_schedule = {}, frozen_states = {}}
    local state = {source_recovery_ready = false, source_recovery_mode = "save_game", source_recovery_allow_adoption = true,
        locked_platforms = {[3] = record}}
    local context = setmetatable({storage = state, game = {forces = {player = f}},
        require = function(name)
            if name:find("platform-schedule",1,true) then return {apply = function() return false,"injected schedule rejection" end} end
            return {ACTIVATABLE_ENTITY_TYPES = {}}
        end}, {__index = _G})
    local locks_api = assert(loadfile(root .. "utils/surface-lock.lua", "t", context))()
    local ok, err = locks_api.accept_restored_source(3,"old")
    assert(not ok and err:find("injected schedule rejection",1,true))
    assert(state.locked_platforms[3] == record and p.hidden, "failed restoration released the source")
end
print("PASS rejected schedule retains restoration protection")

-- An older checkpoint can predate both the transfer lock and its retirement record.
-- Controller ownership still forbids releasing that uncertain source.
locks[3] = nil
env.storage.async_jobs = {}
recovery.startup()
assert(recovery.begin("pre-retirement", "journal-a", false, "save_game", false).success)
assert(not recovery.reconcile(3, accepted.platformUid, nil, true).success,
    "startup released a source still owned by an unresolved controller handoff")
assert(platform.hidden and locks[3].kind == "startup")
assert(not recovery.finish().success)
print("PASS pre-retirement checkpoint stays protected while ownership is unresolved")
