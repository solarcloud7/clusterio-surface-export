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
