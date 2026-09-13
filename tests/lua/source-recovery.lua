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
    lock_platform = function(p, _, opts) locks[p.index] = {kind = opts.kind, surface_index = p.surface.index}; p.hidden = true; return true end,
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
env.require = function(name)
    if name:find("destination-hold", 1, true) then return {reconcile_legacy = function() end} end
    if name:find("platform-identity", 1, true) then return assert(loadfile(root .. "utils/platform-identity.lua", "t", env))() end
    return lock_api
end
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
            if name:find("platform-identity", 1, true) then return function() return nil end end
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

local unlock_force = {platforms = {}, set_surface_hidden = function() end}
local unlock_platform = {valid = true, index = 3, surface = {valid = true, index = 8},
    hub = {valid = true, unit_number = 16}}
unlock_force.platforms[3] = unlock_platform
local e = setmetatable({storage = {source_recovery_ready = true, locked_platforms = {},
        source_recovery_identities = {[3] = {surface_index = 8, hub_unit_number = 16, uid = "current:16"}}},
    game = {forces = {player = unlock_force}, print = function() end}, log = function() end}, {__index = _G})
local real_recovery
e.require = function(name)
    if name:find("platform-identity", 1, true) then return assert(loadfile(root .. "utils/platform-identity.lua", "t", e))() end
    return {ACTIVATABLE_ENTITY_TYPES = {}}
end
local real_lock = assert(loadfile(root .. "utils/surface-lock.lua", "t", e))()
real_recovery = assert(loadfile(root .. "core/source-recovery.lua", "t", e))()
e.require = function() error("Require cannot be used outside control.lua parsing") end
local held = {kind = "transfer", phase = "committed", transfer_job_id = "old", platform_name = "fixture",
    force_name = "player", platform_index = 3, surface_index = 8, platform_uid = "current:16", frozen_states = {}}
e.storage.locked_platforms[3] = held
assert(not real_lock.unlock_platform(3), "normal unlock released a committed source")
assert(not real_lock.accept_restored_source(3, "old"), "adoption outside startup was authorized")
e.storage.source_recovery_ready = false
e.storage.source_recovery_mode = "save_game"
assert(not real_lock.accept_restored_source(3, "old"), "unresolved handoff was released")
e.storage.source_recovery_allow_adoption = true
assert(not real_lock.accept_restored_source(3, "foreign"), "another job bypassed the committed guard")
e.storage.source_recovery_ready = true
e.storage.source_recovery_notices = {[3] = {status = "accepted", platformUid = "current:16"}}
held.phase = "pre_commit"; held.transfer_job_id = "new"
assert(not real_lock.unlock_platform(3, nil, nil, nil, "old"), "delayed old unlock released the new transfer")
assert(not real_lock.unlock_platform(3), "unidentified unlock released an accepted restoration")
assert(e.storage.locked_platforms[3] == held, "rejected unlock mutated the lock")
print("PASS real committed lock and delayed unlock guards")

assert(real_lock.unlock_current_lock(3, held), "local cleanup could not release its observed lock")
e.storage.locked_platforms[3] = held
assert(not real_lock.unlock_current_lock(3, {}), "a replaced lock was released by stale local cleanup")
held.phase = "committed"
assert(not real_lock.unlock_current_lock(3, held), "local cleanup bypassed committed ownership")
held.phase = "pre_commit"
e.storage.source_recovery_ready = false
assert(not real_lock.unlock_current_lock(3, held), "local cleanup bypassed startup recovery")
e.storage.source_recovery_ready = true
held.kind = "manual"; held.transfer_job_id = nil
assert(real_lock.unlock_current_lock(3, held), "manual lock could not be released after save adoption")
held.kind = "transfer"; held.transfer_job_id = "new"
e.storage.locked_platforms[3] = held
assert(real_lock.unlock_platform(3, nil, nil, nil, "new"), "current job could not release its own lock")
e.storage.locked_platforms[3] = held
print("PASS current local cleanup and current job unlock preserve ownership guards")

e.storage.source_recovery_notices[3].platformUid = nil
assert(not real_lock.unlock_platform(3), "a notice without identity bypassed restoration protection")
e.storage.source_recovery_notices[3].platformUid = "retired:15"
assert(real_lock.unlock_platform(3), "a stale notice for another UID blocked an unrelated platform")
assert(e.storage.locked_platforms[3] == nil)
e.storage.locked_platforms[3] = held
e.storage.source_recovery_identities = {}
assert(not real_lock.unlock_platform(3), "an unverified current identity bypassed restoration protection")
assert(e.storage.locked_platforms[3] == held)
print("PASS restoration notices require the live platform identity")

recovery.startup()
assert(recovery.begin("pending-boot", "journal-a", true, "save_game", true).success)
env.storage.async_jobs = {pending = {platform_index = 3}}
assert(recovery.reconcile(3, accepted.platformUid, "pending-job").quarantined,
    "controller history overrode a job still owned by the loaded save")
assert(platform.hidden)
print("PASS loaded Lua jobs retain ownership in Save game mode")

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

locks[3] = nil
env.storage.async_jobs = {}
recovery.startup()
assert(recovery.begin("pre-retirement", "journal-a", false, "save_game", false).success)
assert(not recovery.reconcile(3, accepted.platformUid, nil, true).success,
    "startup released a source still owned by an unresolved controller handoff")
assert(platform.hidden and locks[3].kind == "startup")
assert(not recovery.finish().success)
print("PASS pre-retirement checkpoint stays protected while ownership is unresolved")

local live_notice = env.storage.source_recovery_notices[3]
local live_identity = env.storage.source_recovery_identities[3]
env.storage.source_recovery_notices[99] = {platformUid = "gone", status = "accepted"}
env.storage.source_recovery_identities[99] = {uid = "gone"}
local receipts = {source_delete = {records = {old = {platform_index = 99}}, order = {"old"}, next_slot = 2}}
env.storage.surface_export_transfer_receipts = receipts
local preserved_lock = locks[3]
local hub = platform.hub
platform.hub = {valid = false}
assert(not recovery.begin("prune-failed", "journal-a", true).success)
assert(env.storage.source_recovery_notices[99] and env.storage.source_recovery_identities[99],
    "partial roster pruned metadata")
platform.hub = hub
assert(recovery.begin("prune-complete", "journal-a", true).success)
assert(not env.storage.source_recovery_notices[99] and not env.storage.source_recovery_identities[99],
    "absent platform metadata was retained")
assert(env.storage.source_recovery_notices[3] == live_notice and env.storage.source_recovery_identities[3] == live_identity)
assert(locks[3] == preserved_lock and env.storage.surface_export_transfer_receipts == receipts and receipts.source_delete.records.old,
    "metadata pruning changed transfer authority")
print("PASS complete roster prunes only absent platform metadata")

do
    local failures = {}
    local function check(label, fn)
        e.storage.source_recovery_ready = true
        e.storage.source_recovery_notices = {}
        e.storage.source_recovery_identities = {[3] = {surface_index = 8, hub_unit_number = 16, uid = "current:16"}}
        e.game.tick = 1
        held.kind = "transfer"; held.phase = "pre_commit"; held.transfer_job_id = "new"
        held.platform_uid = "current:16"
        held.force_name = "player"; held.platform_index = 3
        e.storage.locked_platforms[3] = held
        local ok, err = pcall(fn)
        if not ok then failures[#failures + 1] = label .. ": " .. tostring(err) end
    end
    setmetatable(e.game.forces, {__index=function(_, key)
        assert(type(key)=="string", "Factorio force lookup requires a string")
    end})
    for _, field in ipairs({"force_name", "platform_index"}) do
        check("missing " .. field .. " retains source ownership", function()
            held[field]=nil
            assert(not real_lock.transfer_delete_identity_ok(held, unlock_platform.surface, "new"))
            assert(real_lock.get_source_transfer_lock_state("new",3,"fixture","player").state=="identity_mismatch")
            assert(not real_lock.unlock_platform(3,nil,nil,nil,"new"))
            assert(e.storage.locked_platforms[3]==held, "incomplete metadata released ownership")
        end)
    end
    check("rename preserves verified deletion and source state", function()
        unlock_platform.name="renamed-live-copy"
        assert(real_lock.transfer_delete_identity_ok(held, unlock_platform.surface, "new"))
        assert(real_lock.get_source_transfer_lock_state("new",3,"old-display-name","player").state=="pre_commit")
        held.phase="committed"
        assert(real_lock.get_source_transfer_lock_state("new",3,"old-display-name","player").state=="committed")
    end)
    check("display text cannot veto the owning job", function()
        assert(real_lock.unlock_platform(3, "Platform #3", nil, nil, "new"))
    end)
    check("same indexes cannot unlock a different UID", function()
        held.platform_uid = "retired:16"
        assert(not real_lock.unlock_platform(3, nil, nil, nil, "new"))
        assert(e.storage.locked_platforms[3] == held)
    end)
    check("a missing lock job cannot authorize deletion", function()
        held.transfer_job_id = nil
        assert(not real_lock.transfer_delete_identity_ok(held, unlock_platform.surface, "new"))
    end)
    check("a missing lock job cannot certify ownership", function()
        held.transfer_job_id = nil
        assert(real_lock.get_source_transfer_lock_state("new", 3, "fixture", "player").state == "identity_mismatch")
    end)
    check("a stale lock cannot certify a replacement copy", function()
        held.platform_uid = "retired:16"
        assert(real_lock.get_source_transfer_lock_state("new", 3, "fixture", "player").state == "identity_mismatch")
    end)
    assert(#failures == 0, table.concat(failures, "\n"))
end
print("PASS source mutations require copy and job identity, independent of display names")

unlock_platform.force={name="player"}
e.remote={call=function(interface, method, index, name, job)
    assert(interface=="surface_export" and method=="unlock_platform" and name==nil)
    return real_lock.unlock_platform(index,nil,nil,nil,job)
end}
local cleanup=assert(loadfile("tests/lab-gallery/fixture-unlock.lua","t",e))()
held.platform_uid="current:16"; held.transfer_job_id="new"; held.phase="pre_commit"
e.storage.locked_platforms[3]=held
assert(cleanup(unlock_platform) and not e.storage.locked_platforms[3], "fixture cleanup missed owning job")
assert(cleanup(unlock_platform), "absent fixture lock was not a no-op")
for _, fault in ipairs({"uid", "job", "location", "committed"}) do
    held.platform_uid=fault=="uid" and "old-copy" or "current:16"
    held.transfer_job_id=fault~="job" and "new" or nil
    held.surface_index=fault=="location" and 99 or 8
    held.phase=fault=="committed" and "committed" or "pre_commit"
    e.storage.locked_platforms[3]=held
    local removed=false
    local ok=pcall(function() cleanup(unlock_platform); removed=true end)
    assert(not ok and not removed and e.storage.locked_platforms[3]==held, "fixture cleanup ignored "..fault.." refusal")
end
print("PASS fixture cleanup uses the owning job and stops on source protection refusals")

local deleted = {}
local sweep_env={game={delete_surface=function(surface) deleted[#deleted+1]=surface.index; return true end}}
setmetatable(sweep_env,{__index=_G})
local sweep=assert(loadfile("tests/lab-gallery/fixture-sweep.lua","t",sweep_env))()
local platforms={}
for index=1,3 do platforms[index]={valid=true,index=index,surface={valid=true,index=index}} end
local result=sweep(platforms,function(p) return p.index~=3 end,function(p)
    assert(p.index~=1,"protected source"); return true
end)
assert(not result.success and result.swept==1 and #result.errors==1)
assert(result.errors[1].index==1 and #deleted==1 and deleted[1]==2)
print("PASS refused cleanup retains the protected source and continues other owned fixtures")

local gui_uid, started = "copy-a", 0
local gui_platform={valid=true,index=3,name="renamed",force={name="player"}}
local gui_force={platforms={[3]=gui_platform}}
local gui_player={index=1,print=function() end,gui={screen={}}}
local gui_env=setmetatable({game={forces={player=gui_force}}},{__index=_G})
gui_env.require=function(name)
    if name:find("platform-identity",1,true) then return function() return gui_uid end end
    if name:find("gateway-guard",1,true) then return {guard_and_transfer=function(opts) return {started=opts.start_fn()} end} end
    if name:find("transfer-trigger",1,true) then return {start=function() started=started+1;return true end} end
    if name:find("surface-lock",1,true) then return {is_locked=function() return false end} end
    return {parked_at_gateway=function() return "gateway" end,collect_passengers=function() return {},0 end}
end
local gui=assert(loadfile(root.."interfaces/gui/gateway-transfer.lua","t",gui_env))()
local selection={platform_index=3,platform_uid="copy-a",force_name="player",gateway_name="gateway",selected=1,
    targets={{instanceId=2}}}
gui.confirm_transfer(gui_player,selection)
assert(started==1,"renamed same-copy selection was refused")
gui_uid="copy-b";gui.confirm_transfer(gui_player,selection)
assert(started==1,"old in-game dialog started a replacement platform")
selection.platform_uid=nil;gui.confirm_transfer(gui_player,selection)
assert(started==1,"unidentified in-game dialog started a transfer")
print("PASS in-game gateway confirmation binds the displayed copy instead of a reusable index")
