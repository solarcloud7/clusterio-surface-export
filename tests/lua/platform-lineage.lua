local root = "docker/seed-data/external_plugins/surface_export/module/"
local json = assert(loadfile(root .. "core/json.lua"))()
local noop = function() end

local function world()
    local force = {name = "player", platforms = {}, get_surface_hidden = function() return false end, set_surface_hidden = noop}
    local env = setmetatable({storage = {}, game = {tick = 1, forces = {player = force}, print = noop}, log = noop,
        helpers = {json_to_table = json.decode}}, {__index = _G})
    local function add(index, hub_unit_number)
        local platform = {valid = true, index = index, name = "platform-" .. index, force = force,
            surface = {valid = true, index = index + 10}, hub = {valid = true, unit_number = hub_unit_number}}
        force.platforms[index] = platform
        return platform
    end
    return env, force, add
end

local function recovery_world()
    local env, force, add = world()
    local locks = {}
    env.storage.locked_platforms = locks
    local lock_api = {
        get_lock_data = function(index) return locks[index] end,
        destination_hold_owns_surface = function() return false end,
        lock_platform = function(p, _, opts) locks[p.index] = {kind = opts.kind, surface_index = p.surface.index}; p.hidden = true; return true end,
        unlock_platform = function(index, _, bootstrap)
            assert(bootstrap, "bootstrap must explicitly own its unlock")
            assert(locks[index].kind == "startup", "recovery released a non-startup lock")
            locks[index] = nil; force.platforms[index].hidden = false; return true
        end,
    }
    env.require = function(name)
        if name:find("destination-hold", 1, true) then return {reconcile_legacy = noop} end
        if name:find("platform-identity", 1, true) then return assert(loadfile(root .. "utils/platform-identity.lua", "t", env))() end
        if name:find("platform-lineage", 1, true) then return assert(loadfile(root .. "utils/platform-lineage.lua", "t", env))() end
        return lock_api
    end
    local recovery = assert(loadfile(root .. "core/source-recovery.lua", "t", env))()
    return env, force, add, locks, recovery
end

local function verdict(fields) return json.encode(fields) end

do
    local env, _, add, locks, recovery = recovery_world()
    local matched = add(4, 40)
    local unmatched = add(5, 50)
    recovery.startup()
    assert(matched.hidden and unmatched.hidden)
    local begin = recovery.begin("dev-one-boot", "journal-with-records", true, "plugin_history", false)
    assert(begin.success, "an unidentified platform in an older save blocked the whole instance: " .. tostring(begin.error))
    local by_index = {}
    for _, entry in ipairs(begin.platforms) do by_index[entry.platformIndex] = entry end
    assert(by_index[4].hadIdentity == false and by_index[5].hadIdentity == false, "legacy platforms reported an identity")
    assert(by_index[4].hubUnitNumber == 40 and by_index[4].surfaceIndex == 14 and by_index[4].lineage == nil)
    assert(by_index[4].lockKind == "startup")
    assert(env.storage.surface_export_lineages == nil or next(env.storage.surface_export_lineages) == nil, "begin wrote a lineage")
    assert(not recovery.finish().success, "finish accepted unreconciled startup protection")
    local held = recovery.reconcile(4, by_index[4].platformUid, nil, false,
        verdict({verdict = "legacy_unclassified", journalHubMatch = true}))
    assert(held.success and held.quarantined and held.notice.status == "quarantined" and held.notice.reason == "legacy_unclassified")
    assert(locks[4].kind == "quarantine" and locks[4].quarantine.reason == "legacy_unclassified" and matched.hidden)
    local released = recovery.reconcile(5, by_index[5].platformUid, nil, false,
        verdict({verdict = "normal", mint = true, lineage = "lineage:dev-one-boot:50", generation = 0}))
    assert(released.success and not released.quarantined and not unmatched.hidden, "unmatched legacy platform stayed protected")
    assert(env.storage.surface_export_lineages[5].lineage == "lineage:dev-one-boot:50")
    local finished = recovery.finish()
    assert(finished.success and finished.quarantined == 1 and env.storage.source_recovery_ready == true)
    assert(matched.hidden and locks[4].kind == "quarantine", "quarantine released at finish")
    recovery.startup()
    local again = recovery.begin("next-boot", "journal-with-records", true)
    for _, entry in ipairs(again.platforms) do by_index[entry.platformIndex] = entry end
    assert(by_index[4].hadIdentity == false, "a recovery-assigned identity lost its legacy marker")
    assert(by_index[4].lockKind == "quarantine" and by_index[5].lineage == "lineage:dev-one-boot:50")
    print("PASS Dev One: a hub-matched legacy platform is quarantined alone; the other gets a silent lineage; the instance becomes ready")
end

do
    local env, _, add = world()
    local lock_data = {}
    local holds = {}
    env.storage.destination_holds = holds
    env.require = function()
        return {get_lock_data = function(index) return lock_data[index] end,
            destination_hold_owns_surface = function(_, p) return holds.owned == p end}
    end
    local lineage = assert(loadfile(root .. "utils/platform-lineage.lua", "t", env))()
    assert(lineage.valid("lineage:boot:15") and not lineage.valid("boot:15"), "a per-copy uid was accepted as a lineage")
    assert(not lineage.valid("lineage:a:b:15") and not lineage.valid("lineage:boot:0") and not lineage.valid("lineage::15"))
    assert(lineage.valid_generation(0) and not lineage.valid_generation(-1) and not lineage.valid_generation(1.5))
    local p = add(3, 30)
    assert(not lineage.ensure(p), "lineage minted before recovery began")
    env.storage.source_recovery_epoch = "epoch"
    env.storage.source_recovery_ready = false
    assert(not lineage.ensure(p), "lineage minted while recovery was reconciling")
    env.storage.source_recovery_ready = true
    for _, kind in ipairs({"startup", "quarantine"}) do
        lock_data[3] = {kind = kind}
        local minted, err = lineage.ensure(p)
        assert(not minted and err:find("protected", 1, true), kind .. " lock allowed a lineage")
    end
    lock_data[3] = {kind = "transfer"}
    holds.owned = p
    assert(not lineage.ensure(p), "destination hold received a fresh lineage")
    holds.owned = nil
    local minted, generation = lineage.ensure(p)
    assert(minted == "lineage:epoch:30" and generation == 0)
    assert(lineage.ensure(p) == minted, "ensure replaced an existing lineage")
    p.hub = {valid = true, unit_number = 31}
    assert(lineage.get(p) == nil, "a lineage followed a replaced hub")
    p.hub = {valid = true, unit_number = 30}
    p.surface = {valid = true, index = 99}
    assert(lineage.get(p) == nil, "a lineage followed a reused index")
    p.surface = {valid = true, index = 13}
    local other = add(4, 40)
    assert(not lineage.record(other, minted, 0), "two local platforms carried one lineage")
    assert(not lineage.record(other, "4:40", 0), "a per-copy uid was stored as a lineage")
    print("PASS lineage store guards: prefix, generation, readiness, recovery locks, holds, hub and surface binding")

    lock_data[4] = {kind = "quarantine"}
    local none, _, err = lineage.for_export(other, true)
    assert(not none and err and err:find("Transfer requires a platform lineage", 1, true), "a transfer export ran without a lineage")
    local download, download_generation, download_err = lineage.for_export(other, false)
    assert(download == nil and download_generation == nil and download_err == nil, "a download export was refused")
    lock_data[4] = nil
    assert(lineage.for_export(other, true) == "lineage:epoch:40")
    print("PASS transfer exports require a lineage; downloads do not")

    assert(lineage.transfer_carry({_transferId = "1:job", _lineage = "lineage:e:5", _lineageGeneration = 2}) == "lineage:e:5")
    assert(lineage.transfer_carry({_transferId = "restore:x", _standaloneImport = true, _lineage = "lineage:e:5", _lineageGeneration = 2}) == nil,
        "a standalone import adopted the payload lineage")
    assert(lineage.transfer_carry({_lineage = "lineage:e:5", _lineageGeneration = 2}) == nil, "a clone adopted the payload lineage")
    assert(lineage.transfer_carry({_transferId = "1:legacy"}) == nil)
    local _, _, carry_err = lineage.transfer_carry({_transferId = "1:job", _lineage = "1:5", _lineageGeneration = 2})
    assert(carry_err, "an invalid transfer lineage was accepted")
    local held = lineage.hold_carry({lineage = "lineage:e:5", lineage_generation = 2, transfer_id = "1:job", platform_data = {}})
    assert(held and held.lineage == "lineage:e:5" and held.generation == 3, "the destination hold did not advance the generation")
    assert(lineage.hold_carry({lineage = "lineage:e:5", lineage_generation = 2, transfer_id = "restore:x",
        platform_data = {_standaloneImport = true}}) == nil, "a standalone import hold adopted a lineage")
    assert(lineage.hold_carry({lineage = "lineage:e:5", lineage_generation = 2, platform_data = {}}) == nil)
    print("PASS only controller transfers carry the payload lineage")

    assert(lineage.presence(minted).present == true)
    assert(lineage.presence("lineage:epoch:77").present == false)
    holds.transfer = {lineage = "lineage:epoch:77", generation = 3}
    local held = lineage.presence("lineage:epoch:77")
    assert(held.present and held.held and held.generation == 3, "a held destination copy was reported absent")
    assert(not lineage.presence("epoch:77"), "presence accepted a per-copy uid")
    print("PASS presence counts live records and destination holds")
end

do
    local platform = {valid = true, index = 3, surface = {valid = true, index = 8}, hub = {valid = true, unit_number = 16}, hidden = true}
    local force = {platforms = {[3] = platform}, set_surface_hidden = noop}
    local env = setmetatable({storage = {source_recovery_ready = true, locked_platforms = {},
            source_recovery_identities = {[3] = {surface_index = 8, hub_unit_number = 16, uid = "current:16"}}},
        game = {tick = 100000, forces = {player = force}, print = noop}, log = noop}, {__index = _G})
    env.require = function(name)
        if name:find("platform-identity", 1, true) then return assert(loadfile(root .. "utils/platform-identity.lua", "t", env))() end
        if name:find("passenger-transit", 1, true) then return {transfer_released = noop} end
        if name:find("platform-schedule", 1, true) then return {apply = function() return true end} end
        return {ACTIVATABLE_ENTITY_TYPES = {}}
    end
    local locks = assert(loadfile(root .. "utils/surface-lock.lua", "t", env))()
    local q = {kind = "quarantine", platform_name = "q", force_name = "player", platform_index = 3, surface_index = 8,
        platform_uid = "current:16", locked_tick = 1, expires_tick = 2, frozen_states = {}, original_platform_hidden = false,
        quarantine = {reason = "duplicate", lineage = "lineage:e:16", epoch = "boot"}}
    env.storage.locked_platforms[3] = q
    assert(not locks.unlock_platform(3), "generic unlock released a quarantine")
    assert(not locks.unlock_platform(3, nil, true), "startup recovery released a quarantine")
    assert(not locks.unlock_platform(3, nil, nil, nil, nil), "a jobless unlock released a quarantine")
    assert(not locks.unlock_current_lock(3, q), "local cleanup or /unlock-platform released a quarantine")
    assert(not locks.transfer_delete_identity_ok(q, platform.surface, "job"), "a quarantine authorized source deletion")
    assert(locks.get_source_transfer_lock_state("job", 3, "q", "player").state == "identity_mismatch",
        "a quarantine certified transfer ownership")
    local scan = locks.scan_transfer_expiries()
    assert(scan.checked == 0 and scan.failed == 0 and scan.expired == 0, "the expiry scanner examined a quarantine")
    assert(env.storage.locked_platforms[3] == q and platform.hidden)
    assert(not locks.release_quarantine(3, {reason = "duplicate", lineage = "lineage:e:99", epoch = "boot"}))
    assert(not locks.release_quarantine(3, {reason = "unverified", lineage = "lineage:e:16", epoch = "boot"}))
    assert(env.storage.locked_platforms[3] == q)
    assert(locks.release_quarantine(3, {reason = "duplicate", lineage = "lineage:e:16", epoch = "boot"}))
    assert(env.storage.locked_platforms[3] == nil and platform.hidden == false)
    print("PASS only a matching recovery resolution releases a quarantine")
end

do
    local env, _, add, locks, recovery = recovery_world()
    local p = add(6, 60)
    env.storage.surface_export_lineages = {[6] = {lineage = "lineage:old:60", generation = 1, surface_index = 16, hub_unit_number = 60}}
    recovery.startup()
    local begin = recovery.begin("boot", "journal", false, "plugin_history", false)
    local uid = begin.platforms[1].platformUid
    assert(begin.platforms[1].lineage == "lineage:old:60" and begin.platforms[1].generation == 1)
    for _, reason in ipairs({"duplicate", "unverified", "stale_self", "ahead_of_registry", "unregistered", "in_transit",
        "rollback_other", "duplicate_local", "legacy_unclassified", "no_identity"}) do
        locks[6] = {kind = "startup", surface_index = 16}
        p.hidden = true
        local result = recovery.reconcile(6, uid, nil, false,
            verdict({verdict = reason, lineage = "lineage:old:60", generation = 1, holderInstanceId = 2, holderGeneration = 2}))
        assert(result.success and result.quarantined and locks[6].kind == "quarantine" and p.hidden, reason .. " released the platform")
        assert(locks[6].quarantine.reason == reason and locks[6].quarantine.holder_instance_id == 2 and locks[6].quarantine.epoch == "boot")
    end
    locks[6] = {kind = "startup", surface_index = 16}
    local changed = recovery.reconcile(6, uid, nil, false, verdict({verdict = "normal", lineage = "lineage:old:60", generation = 0}))
    assert(changed.quarantined and locks[6].quarantine.reason == "reconcile_error", "a stale verdict released the platform")
    locks[6] = {kind = "startup", surface_index = 16}
    local forged = recovery.reconcile(6, uid, nil, false, verdict({verdict = "normal", mint = true, lineage = "lineage:boot:61", generation = 0}))
    assert(forged.quarantined and locks[6].quarantine.reason == "reconcile_error", "a forged mint replaced a lineage")
    locks[6] = {kind = "startup", surface_index = 16}
    assert(recovery.reconcile(6, uid, nil, false, "not json").quarantined, "an unreadable verdict released the platform")
    local fresh = add(7, 70)
    locks[7] = {kind = "startup", surface_index = 17}
    fresh.hidden = true
    local fresh_uid
    for _, entry in ipairs(recovery.begin("boot", "journal", false, "plugin_history", false).platforms) do
        if entry.platformIndex == 7 then fresh_uid = entry.platformUid end
    end
    assert(fresh_uid == "boot:70")
    local wrong_mint = recovery.reconcile(7, fresh_uid, nil, false, verdict({verdict = "normal", mint = true, lineage = "lineage:boot:71", generation = 0}))
    assert(wrong_mint.quarantined and locks[7].quarantine.reason == "reconcile_error" and fresh.hidden, "a mint for another hub was recorded")
    assert(not (env.storage.surface_export_lineages or {})[7])
    locks[7] = {kind = "startup", surface_index = 17}
    local late_mint = recovery.reconcile(7, fresh_uid, nil, false, verdict({verdict = "normal", mint = true, lineage = "lineage:boot:70", generation = 1}))
    assert(late_mint.quarantined, "a mint started above generation zero")
    locks[7] = {kind = "startup", surface_index = 17}
    assert(recovery.reconcile(7, fresh_uid, nil, false, verdict({verdict = "normal", mint = true, lineage = "lineage:boot:70", generation = 0})).success)
    assert(locks[7] == nil and env.storage.surface_export_lineages[7].lineage == "lineage:boot:70")
    fresh.valid = false
    env.game.forces.player.platforms[7] = nil
    locks[6] = {kind = "startup", surface_index = 16}
    local adopt = verdict({verdict = "rollback_other", adopt = true, lineage = "lineage:old:60", generation = 1, adoptGeneration = 3})
    assert(recovery.reconcile(6, uid, nil, false, adopt).quarantined, "plugin_history adopted a rolled-back copy")
    locks[6] = {kind = "startup", surface_index = 16}
    assert(recovery.reconcile(6, uid, nil, false, verdict({verdict = "normal", lineage = "lineage:old:60", generation = 1})).success)
    assert(locks[6] == nil and not p.hidden and env.storage.surface_export_lineages[6].generation == 1)
    print("PASS only a normal verdict unlocks; every other verdict, stale verdict, forged mint or unreadable verdict quarantines")

    recovery.startup()
    assert(recovery.begin("save-boot", "journal", false, "save_game", true).success)
    local adopted = recovery.reconcile(6, uid, nil, false, adopt)
    assert(adopted.success and not adopted.quarantined and locks[6] == nil and adopted.notice.status == "accepted")
    assert(env.storage.surface_export_lineages[6].generation == 3, "adoption did not advance the generation")
    recovery.startup()
    assert(recovery.begin("save-boot-2", "journal", false, "save_game", true).success)
    local lower = verdict({verdict = "rollback_other", adopt = true, lineage = "lineage:old:60", generation = 3, adoptGeneration = 3})
    assert(recovery.reconcile(6, uid, nil, false, lower).quarantined, "adoption kept a non-increasing generation")
    locks[6] = {kind = "startup", surface_index = 16}
    assert(recovery.reconcile(6, uid, nil, false, verdict({verdict = "duplicate", adopt = true, adoptGeneration = 4,
        lineage = "lineage:old:60", generation = 3})).quarantined, "save_game adopted a duplicate")
    local finished = recovery.finish()
    assert(finished.success and finished.quarantined == 1)
    print("PASS save_game adopts only rollback_other with a higher generation")

    local answer = recovery.lineage_presence(json.encode({"lineage:old:60", "lineage:none:1"}))
    assert(answer.success and answer.lineages[1].present == true and answer.lineages[1].generation == 3,
        "a quarantined copy was reported absent")
    assert(answer.lineages[1].platformIndex == 6 and answer.lineages[1].platformUid == uid, "presence did not identify the holding copy")
    assert(answer.lineages[2].present == false)
    env.storage.source_recovery_ready = false
    assert(not recovery.lineage_presence(json.encode({"lineage:old:60"})).success, "a reconciling instance answered presence")
    print("PASS presence answers only when recovery is ready")
end

do
    local force = {name = "player", valid = true, platforms = {}, set_surface_hidden = noop, get_surface_hidden = function() return false end}
    local env = setmetatable({storage = {source_recovery_ready = true, locked_platforms = {}, source_recovery_identities = {}},
        game = {tick = 50, forces = {player = force}, print = noop}, log = noop}, {__index = _G})
    local function add(index, hub)
        local platform = {valid = true, index = index, name = "ship-" .. index, force = force, hidden = false,
            surface = {valid = true, index = index + 10}, hub = {valid = true, unit_number = hub}}
        force.platforms[index] = platform
        env.storage.source_recovery_identities[index] = {uid = "a:" .. hub, surface_index = index + 10, hub_unit_number = hub}
        return platform
    end
    local deleted = {}
    local modules = {}
    env.require = function(name)
        local short = name:match("^modules/surface_export/(.*)$") or name
        if modules[short] then return modules[short] end
        local loaded
        if short == "utils/platform-identity" or short == "utils/surface-lock" or short == "utils/platform-lineage"
            or short == "utils/transfer-receipts" then
            loaded = assert(loadfile(root .. short .. ".lua", "t", env))()
        elseif short == "utils/game-utils" then
            loaded = {ACTIVATABLE_ENTITY_TYPES = {}, delete_platform = function(p)
                deleted[#deleted + 1] = p.index; force.platforms[p.index] = nil; p.valid = false; return true end}
        elseif short == "utils/platform-schedule" then
            loaded = {apply = function() return true end, capture = function() return {} end}
        elseif short == "core/gateway" then
            loaded = {evacuate_passengers = function() return {success = true, failures = 0} end}
        elseif short == "core/source-recovery" then
            loaded = {matches = function(p, uid) return modules["utils/platform-identity"](p) == uid end}
        elseif short == "core/passenger-transit" then
            loaded = {depart = function() return {} end, settle = noop, notify_departed = noop, transfer_released = noop}
        elseif short == "utils/operation-timing" then
            loaded = setmetatable({scope = function(_, _, fn, ...) return fn(...) end}, {__index = function() return noop end})
        else
            loaded = setmetatable({}, {__index = function() return noop end})
        end
        modules[short] = loaded
        return loaded
    end
    env.require("utils/platform-identity")
    local locks = env.require("utils/surface-lock")
    local lineage = env.require("utils/platform-lineage")
    local delete = assert(loadfile(root .. "interfaces/remote/delete-platform-for-transfer.lua", "t", env))()
    local L = "lineage:boot-a:30"

    local outbound = add(3, 30)
    assert(lineage.record(outbound, L, 0))
    env.storage.locked_platforms[3] = {kind = "transfer", phase = "pre_commit", transfer_job_id = "job-out", platform_name = "ship-3",
        force_name = "player", platform_index = 3, surface_index = 13, platform_uid = "a:30", frozen_states = {}}
    assert(delete(3, "ship-3", "player", "job-out", "a:30") == "SUCCESS")
    assert(env.storage.surface_export_lineages[3] == nil, "a deleted source kept its lineage record")
    local returned = add(5, 31)
    assert(lineage.record(returned, L, 2), "the platform could not return to the instance it left")
    env.storage.surface_export_lineages[3] = {lineage = L, generation = 0, surface_index = 13, hub_unit_number = 30}
    assert(lineage.record(returned, L, 2), "a stale record from a departed platform blocked the return trip")
    local reused = add(3, 32)
    assert(lineage.record(reused, "lineage:boot-a:32", 0), "a reused index was blocked by the departed platform's record")
    print("PASS a platform can return to an instance it left, and an index can be reused")

    local held = add(4, 40)
    held.hidden = true
    local function quarantine(owner)
        env.storage.locked_platforms[4] = {kind = "quarantine", platform_name = "ship-4", force_name = "player", platform_index = 4,
            surface_index = 14, platform_uid = "a:40", frozen_states = {}, original_platform_hidden = false,
            quarantine = {reason = "in_transit", lineage = "lineage:boot-a:40", epoch = "boot", owner_job_id = owner}}
        held.hidden = true
        return env.storage.locked_platforms[4]
    end
    local q = quarantine("job-in-flight")
    assert(not locks.unlock_platform(4, nil, nil, nil, "job-other"), "another transfer released an in-transit quarantine")
    assert(not locks.unlock_current_lock(4, q), "a generic unlock released an in-transit quarantine")
    assert(locks.get_source_transfer_lock_state("job-other", 4, "ship-4", "player").state == "identity_mismatch")
    assert(locks.get_source_transfer_lock_state("job-in-flight", 4, "ship-4", "player").state == "pre_commit",
        "the owning transfer could not prove its source was never deleted")
    assert(locks.unlock_platform(4, nil, nil, nil, "job-in-flight"), "the owning transfer's rollback could not release its source")
    assert(env.storage.locked_platforms[4] == nil and held.hidden == false, "the rolled-back source is not usable")
    quarantine(nil)
    assert(not locks.unlock_platform(4, nil, nil, nil, "job-in-flight"), "a quarantine without an owner was released by a job")
    assert(delete(4, "ship-4", "player", "job-in-flight", "a:40"):find("^ERROR:"), "an unowned quarantine was deleted")
    quarantine("job-in-flight")
    assert(delete(4, "ship-4", "player", "job-other", "a:40"):find("^ERROR:"), "another transfer deleted an in-transit quarantine")
    assert(held.valid and env.storage.locked_platforms[4].kind == "quarantine")
    assert(delete(4, "ship-4", "player", "job-in-flight", "a:40") == "SUCCESS", "the owning transfer could not delete its source")
    assert(not held.valid and env.storage.locked_platforms[4] == nil)
    print("PASS an in-transit quarantine is resolved only by its own transfer: rollback releases it, success deletes it")
end

do
    local env, _, add, locks, recovery = recovery_world()
    add(8, 80)
    recovery.startup()
    local uid = recovery.begin("boot", "journal", false, "plugin_history", false).platforms[1].platformUid
    local in_transit = recovery.reconcile(8, uid, nil, false,
        verdict({verdict = "in_transit", mint = true, lineage = "lineage:boot:80", generation = 0, ownerJobId = "job-8"}))
    assert(in_transit.quarantined and locks[8].quarantine.owner_job_id == "job-8", "an in-transit quarantine lost its owning transfer")
    locks[8] = {kind = "startup", surface_index = 18}
    assert(recovery.reconcile(8, uid, nil, true, verdict({verdict = "normal", ownerJobId = "job-8"})).quarantined)
    assert(locks[8].quarantine.reason == "unresolved_handoff" and locks[8].quarantine.owner_job_id == "job-8")
    locks[8] = {kind = "startup", surface_index = 18}
    assert(recovery.reconcile(8, uid, nil, false, verdict({verdict = "duplicate", ownerJobId = "job-8"})).quarantined)
    assert(locks[8].quarantine.owner_job_id == nil, "a duplicate became releasable by a transfer")
    locks[20] = {kind = "startup", surface_index = 30}
    local absent = recovery.reconcile(20, "gone:1", nil, false, verdict({verdict = "normal"}))
    assert(absent.success and not absent.quarantined and locks[20] == nil, "an absent platform left an orphan lock")
    print("PASS only in-transit and unresolved-handoff quarantines record their owning transfer; absent platforms leave no lock")
end

do
    local env, _, add, locks, recovery = recovery_world()
    local p = add(9, 90)
    add(10, 91)
    env.storage.surface_export_lineages = {[9] = {lineage = "lineage:old:90", generation = 1, surface_index = 19, hub_unit_number = 90}}
    recovery.startup()
    local begin = recovery.begin("save", "journal", true, "save_game", true)
    local uid
    for _, entry in ipairs(begin.platforms) do if entry.platformIndex == 9 then uid = entry.platformUid end end
    local accepted_called = false
    local lock_api = env.require("modules/surface_export/utils/surface-lock")
    lock_api.accept_restored_source = function() accepted_called = true; return true end
    env.storage.surface_export_lineages[10] = {lineage = "lineage:old:90", generation = 0, surface_index = 20, hub_unit_number = 91}
    local refused = recovery.reconcile(9, uid, "job-old", false,
        verdict({verdict = "rollback_other", adopt = true, lineage = "lineage:old:90", generation = 1, adoptGeneration = 2}))
    assert(refused.quarantined and not accepted_called and locks[9].kind == "quarantine" and p.hidden,
        "an adoption whose lineage could not be recorded released the platform")
    assert(env.storage.surface_export_lineages[9].generation == 1)
    print("PASS an adoption whose generation cannot be recorded stays quarantined")
end
