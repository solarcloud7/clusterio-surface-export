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
assert(s.state == "unlocked" and s.error == nil, "a live platform without a lock must report unlocked, got " .. tostring(s.state))

force.platforms[3] = nil
s = state()
assert(s.state == "source_missing" and s.error == nil, "no platform, lock or tombstone must report source_missing, got " .. tostring(s.state))

local dangling = transfer_lock("job")
env.storage.locked_platforms[3] = dangling
s = state()
assert(s.state == "source_missing" and s.error == "uncommitted transfer lock retained for a missing platform",
    "an uncommitted lock whose platform is gone must report source_missing with the retained lock named, got " .. tostring(s.state) .. "/" .. tostring(s.error))
assert(env.storage.locked_platforms[3] == dangling, "the state query must not clear the retained lock")

dangling.phase = "committed"
s = state()
assert(s.state == "identity_mismatch", "a committed lock whose platform is gone stays identity_mismatch, got " .. tostring(s.state))

dangling.phase = "pre_commit"
force.platforms[3] = platform()
assert(state().state == "pre_commit", "a matching uncommitted lock must still report pre_commit")
dangling.phase = "committed"
assert(state().state == "committed", "a matching committed lock must still report committed")

env.storage.locked_platforms[3] = transfer_lock("other")
s = state()
assert(s.state == "identity_mismatch" and s.error == "transfer id mismatch", "another transfer's lock must stay identity_mismatch")

env.storage.locked_platforms[3] = transfer_lock("job")
force.platforms[3] = platform(99)
s = state()
assert(s.state == "identity_mismatch" and s.error == "platform identity mismatch",
    "a reused index with another platform identity must stay identity_mismatch, not source_missing, got " .. tostring(s.state))

env.storage.locked_platforms[3] = nil
force.platforms[3] = nil
env.storage.committed_source_transfer_tombstones = {job = {transfer_id = "job", committed_tick = 900, source_deleted_tick = 950,
    platform_index = 3, force_name = "player", surface_index = 8}}
assert(state().state == "source_gone_matching_transfer", "a deletion receipt must still report source_gone_matching_transfer")
env.storage.committed_source_transfer_tombstones = nil
print("PASS lock-state vocabulary: unlocked, source_missing, retained dangling lock, unchanged pre_commit/committed/mismatch/tombstone")

env, lock, force = new_env()
force.platforms[3] = platform()
env.storage.locked_platforms[3] = transfer_lock("job")
env.storage.surface_export_config = {test_force_unlock_refusal = true}
assert(lock.unlock_platform(3, nil, nil, nil, "job"), "without debug_mode the hook must be inert")
assert(env.storage.surface_export_config.test_force_unlock_refusal == true, "an inert hook must not be consumed")
assert(env.storage.locked_platforms[3] == nil, "the inert-hook unlock must release the lock")

local held = transfer_lock("job")
env.storage.locked_platforms[3] = held
env.storage.surface_export_config = {debug_mode = true, test_force_unlock_refusal = true}
local ok, err = lock.unlock_platform(3, nil, nil, nil, "job")
assert(ok == false and type(err) == "string", "an armed hook must refuse the unlock")
assert(err:find("test_force_unlock_refusal", 1, true), "the refusal must name the hook: " .. err)
assert(not err:find("could not be put back", 1, true), "the refusal must not imitate a cargo restore failure: " .. err)
assert(env.storage.locked_platforms[3] == held and held.phase == "pre_commit", "the refusal mutated or cleared the lock")
assert(force.platforms[3].hidden == nil, "the refusal touched the platform before refusing")
assert(env.storage.surface_export_config.test_force_unlock_refusal == nil, "a one-shot hook must disarm when it fires")
assert(lock.unlock_platform(3, nil, nil, nil, "job"), "the unlock after the disarmed hook must succeed")
assert(env.storage.locked_platforms[3] == nil, "the successful unlock must release the lock")

env.storage.locked_platforms[3] = transfer_lock("job")
env.storage.surface_export_config = {debug_mode = true, test_force_unlock_refusal = 2}
assert(not lock.unlock_platform(3, nil, nil, nil, "job"), "first counted refusal")
assert(env.storage.surface_export_config.test_force_unlock_refusal == 1, "a counted hook must count down")
assert(not lock.unlock_platform(3, nil, nil, nil, "job"), "second counted refusal")
assert(env.storage.surface_export_config.test_force_unlock_refusal == nil, "a counted hook must disarm at zero")
assert(lock.unlock_platform(3, nil, nil, nil, "job"), "unlock after the countdown must succeed")

env.storage.locked_platforms[3] = transfer_lock("job", "committed")
env.storage.surface_export_config = {debug_mode = true, test_force_unlock_refusal = true}
ok, err = lock.unlock_platform(3, nil, nil, nil, "job")
assert(ok == false and err:find("committed", 1, true), "the committed guard must refuse before the hook: " .. tostring(err))
assert(env.storage.surface_export_config.test_force_unlock_refusal == true, "the hook must not fire ahead of the ownership guards")
ok, err = lock.unlock_platform(3, nil, nil, nil, "other")
assert(ok == false and err:find("identity changed", 1, true), "the identity guard must refuse before the hook: " .. tostring(err))
assert(env.storage.surface_export_config.test_force_unlock_refusal == true, "the hook must not fire for a foreign job identity")
env.storage.locked_platforms[3].phase = "pre_commit"
assert(lock.get_source_transfer_lock_state("job", 3, "fixture", "player").state == "pre_commit",
    "an armed unlock hook must not change the reported lock state")
print("PASS fail-safe unlock refusal hook: debug-gated, refuses before any restore, one-shot or counted, behind the ownership guards")
