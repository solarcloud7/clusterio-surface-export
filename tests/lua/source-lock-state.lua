local root = "docker/seed-data/external_plugins/surface_export/module/"
local function noop() end

local function new_env()
    local force = {name = "player", platforms = {}, set_surface_hidden = noop}
    local env = setmetatable({
        storage = {source_recovery_ready = true, locked_platforms = {}, surface_export_config = {},
            source_recovery_identities = {[3] = {surface_index = 8, hub_unit_number = 16, uid = "current:16"}}},
        game = {tick = 1000, forces = {player = force}, print = noop},
        log = noop,
    }, {__index = _G})
    env.require = function(name)
        if name:find("platform-identity", 1, true) then return assert(loadfile(root .. "utils/platform-identity.lua", "t", env))() end
        return {ACTIVATABLE_ENTITY_TYPES = {}}
    end
    local lock = assert(loadfile(root .. "utils/surface-lock.lua", "t", env))()
    env.require = function() error("Require cannot be used outside control.lua parsing") end
    return env, lock, force
end

local function platform(hub_unit_number)
    return {valid = true, index = 3, surface = {valid = true, index = 8}, hub = {valid = true, unit_number = hub_unit_number or 16}}
end

local function transfer_lock(job, phase)
    return {kind = "transfer", phase = phase or "pre_commit", transfer_job_id = job, platform_name = "fixture", force_name = "player",
        platform_index = 3, surface_index = 8, platform_uid = "current:16", frozen_states = {}}
end

local env, lock, force = new_env()
local state = function(job) return lock.get_source_transfer_lock_state(job or "job", 3, "fixture", "player") end

force.platforms[3] = platform()
local s = state()
assert(s.state == "unlocked" and s.error == nil, "a live platform with no lock must report unlocked, got " .. tostring(s.state))

env.storage.locked_platforms[3] = {kind = "export", transfer_job_id = "job", job_id = "job", platform_name = "fixture", force_name = "player",
    platform_index = 3, surface_index = 8, platform_uid = "current:16"}
s = state()
assert(s.state == "identity_mismatch", "a live platform with any lock at its index must never read as unlocked, got " .. tostring(s.state))

env.storage.locked_platforms[3] = transfer_lock("other")
s = state()
assert(s.state == "identity_mismatch" and s.error == "transfer id mismatch", "another transfer's lock stays identity_mismatch")

env.storage.locked_platforms[3] = transfer_lock("job")
assert(state().state == "pre_commit", "a matching uncommitted lock still reports pre_commit")
env.storage.locked_platforms[3].phase = "committed"
assert(state().state == "committed", "a matching committed lock still reports committed")

env.storage.locked_platforms[3] = nil
force.platforms[3] = nil
s = state()
assert(s.state == "identity_mismatch" and s.error == "no matching source lock or tombstone",
    "no platform and no lock is unchanged: identity_mismatch, got " .. tostring(s.state))

env.storage.committed_source_transfer_tombstones = {job = {transfer_id = "job", committed_tick = 900, source_deleted_tick = 950,
    platform_index = 3, force_name = "player", surface_index = 8}}
assert(state().state == "source_gone_matching_transfer", "a deletion receipt still reports source_gone_matching_transfer")
print("PASS lock-state: unlocked only for a live platform with no lock; other states unchanged")

env, lock, force = new_env()
force.platforms[3] = platform()
env.storage.locked_platforms[3] = transfer_lock("job")
env.storage.surface_export_config = {test_force_unlock_refusal = true}
assert(lock.unlock_platform(3, nil, nil, nil, "job"), "without debug_mode the hook must be inert")
assert(env.storage.surface_export_config.test_force_unlock_refusal == true, "an inert hook must not be consumed")

local held = transfer_lock("job")
env.storage.locked_platforms[3] = held
env.storage.surface_export_config = {debug_mode = true, test_force_unlock_refusal = true}
local ok, err = lock.unlock_platform(3, nil, nil, nil, "job")
assert(ok == false and err:find("test_force_unlock_refusal", 1, true), "an armed hook must refuse the unlock and name itself: " .. tostring(err))
assert(not err:find("could not be put back", 1, true), "the refusal must not imitate a cargo restore failure")
assert(env.storage.locked_platforms[3] == held and held.phase == "pre_commit", "the refusal must leave the lock unchanged")
assert(force.platforms[3].hidden == nil, "the refusal must not touch the platform")
assert(env.storage.surface_export_config.test_force_unlock_refusal == nil, "a one-shot hook disarms when it fires")
assert(lock.unlock_platform(3, nil, nil, nil, "job"), "the next unlock succeeds")

env.storage.locked_platforms[3] = transfer_lock("job")
env.storage.surface_export_config = {debug_mode = true, test_force_unlock_refusal = 2}
assert(not lock.unlock_platform(3, nil, nil, nil, "job"), "first counted refusal")
assert(not lock.unlock_platform(3, nil, nil, nil, "job"), "second counted refusal")
assert(env.storage.surface_export_config.test_force_unlock_refusal == nil, "a counted hook disarms at zero")
assert(lock.unlock_platform(3, nil, nil, nil, "job"), "the unlock after the countdown succeeds")

env.storage.locked_platforms[3] = transfer_lock("job", "committed")
env.storage.surface_export_config = {debug_mode = true, test_force_unlock_refusal = true}
ok, err = lock.unlock_platform(3, nil, nil, nil, "job")
assert(ok == false and err:find("committed", 1, true), "the committed guard refuses before the hook: " .. tostring(err))
assert(env.storage.surface_export_config.test_force_unlock_refusal == true, "the hook does not fire ahead of the ownership guards")

env.storage.locked_platforms[3] = transfer_lock("job")
assert(lock.unlock_platform(3), "an unlock without a job identity is outside the hook's scope")
assert(env.storage.surface_export_config.test_force_unlock_refusal == true, "an out-of-scope unlock does not consume the hook")
print("PASS fail-safe unlock refusal hook: debug-gated, before any restore, one-shot or counted, behind the ownership guards, scoped to job-identified transfer unlocks")
