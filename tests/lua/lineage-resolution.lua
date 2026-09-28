local root = "docker/seed-data/external_plugins/surface_export/module/"
local json = assert(loadfile(root .. "core/json.lua"))()
local function noop() end
TOKEN = "controller-issued-token-0123456789abcdef"

local function world()
    local force = {name = "player", valid = true, platforms = {}, set_surface_hidden = noop, get_surface_hidden = function() return false end}
    local env = setmetatable({storage = {source_recovery_ready = true, source_recovery_epoch = "boot-now", locked_platforms = {},
            source_recovery_identities = {}, source_recovery_notices = {}},
        game = {tick = 100, forces = {player = force}, players = {}, print = noop}, log = noop,
        helpers = {json_to_table = function(text) local ok, value = pcall(json.decode, text); if ok then return value end end}},
        {__index = _G})
    local modules, queued = {}, {}
    local function add(index, hub, uid)
        local platform = {valid = true, index = index, name = "ship-" .. index, force = force, hidden = true,
            surface = {valid = true, index = index + 10}, hub = {valid = true, unit_number = hub}}
        force.platforms[index] = platform
        env.storage.source_recovery_identities[index] = {uid = uid or ("old:" .. hub), surface_index = index + 10, hub_unit_number = hub}
        return platform
    end
    local queue_result = "export-job"
    env.require = function(name)
        local short = name:match("^modules/surface_export/(.*)$") or name
        if modules[short] then return modules[short] end
        local loaded
        if short == "utils/platform-identity" or short == "utils/surface-lock" or short == "utils/platform-lineage"
            or short == "utils/transfer-receipts" then
            loaded = assert(loadfile(root .. short .. ".lua", "t", env))()
        elseif short == "core/source-recovery" then
            loaded = assert(loadfile(root .. short .. ".lua", "t", env))()
        elseif short == "utils/game-utils" then
            loaded = {ACTIVATABLE_ENTITY_TYPES = {}, delete_platform = function(p)
                env.deleted = (env.deleted or 0) + 1; force.platforms[p.index] = nil; p.valid = false; return true end}
        elseif short == "utils/operation-timing" then
            loaded = setmetatable({scope = function(_, _, fn, ...) return fn(...) end}, {__index = function() return noop end})
        elseif short == "utils/platform-schedule" then
            loaded = {apply = function() return true end, capture = function() return {} end}
        elseif short == "core/passenger-transit" then
            loaded = {transfer_released = noop, depart = function() return {} end, settle = noop, notify_departed = noop}
        elseif short == "core/destination-hold" then
            loaded = {reconcile_legacy = noop}
        elseif short == "core/gateway" then
            loaded = {evacuate_passengers = function(p)
                    env.evacuated = env.evacuated or {}
                    for _, player in ipairs(p.aboard or {}) do env.evacuated[#env.evacuated + 1] = player.name end
                    p.aboard = {}
                    return {success = true, failures = 0}
                end,
                collect_passengers = function(p) return p.aboard or {}, 0, true end,
                passenger_count = function(players, characters) return math.max(#players, characters) end}
        elseif short == "core/async-processor" then
            loaded = {queue_export = function(index, force_name, requester, destination, _, _, operation, uid, _, purpose)
                queued[#queued + 1] = {index = index, requester = requester, destination = destination, operation = operation,
                    uid = uid, purpose = purpose}
                if not queue_result then return nil, "injected admission refusal" end
                local lock = env.storage.locked_platforms[index]
                assert(not lock or (lock.kind == "transfer" and lock.transfer_job_id == nil), "resolution export found an unconverted lock")
                if lock then lock.transfer_job_id = queue_result end
                return queue_result
            end}
        else
            loaded = setmetatable({}, {__index = function() return noop end})
        end
        modules[short] = loaded
        return loaded
    end
    local locks = env.require("modules/surface_export/utils/surface-lock")
    local lineage = env.require("modules/surface_export/utils/platform-lineage")
    local resolution = assert(loadfile(root .. "interfaces/remote/resolution.lua", "t", env))()
    local function quarantine(index, reason, extra)
        local lock = {kind = "quarantine", platform_name = "ship-" .. index, force_name = "player", platform_index = index,
            surface_index = index + 10, platform_uid = env.storage.source_recovery_identities[index].uid, frozen_states = {},
            original_platform_hidden = false, quarantine = {reason = reason, lineage = extra and extra.lineage, epoch = "boot-old"}}
        env.storage.locked_platforms[index] = lock
        env.storage.source_recovery_notices[index] = {platformIndex = index, status = "quarantined", reason = reason}
        return lock
    end
    local function tombstone(index, job)
        local lock = {kind = "transfer", phase = "committed", transfer_job_id = job, committed_transfer_id = job, committed_tick = 5,
            platform_name = "ship-" .. index, force_name = "player", platform_index = index, surface_index = index + 10,
            platform_uid = env.storage.source_recovery_identities[index].uid, frozen_states = {}, original_platform_hidden = false}
        env.storage.locked_platforms[index] = lock
        env.storage.source_recovery_notices[index] = {platformIndex = index, status = "protected", exportId = job, reason = "duplicate"}
        return lock
    end
    local function apply(request)
        if request.token == nil then request.token = TOKEN end
        if request.token == false then request.token = nil end
        return resolution.apply(json.encode(request))
    end
    local function authorize(requestId, index, uid)
        return apply({requestId = requestId, step = "authorize", platformIndex = index, platformUid = uid})
    end
    return {env = env, add = add, locks = locks, lineage = lineage, resolution = resolution, quarantine = quarantine,
        tombstone = tombstone, apply = apply, authorize = authorize, queued = queued, set_queue = function(value) queue_result = value end}
end

do
    local w = world()
    local p = w.add(3, 30)
    local lock = w.quarantine(3, "duplicate")
    assert(w.locks.convert_for_resolution(3, "req-a"))
    assert(lock.kind == "transfer" and lock.phase == "pre_commit" and lock.transfer_job_id == nil and lock.quarantine == nil)
    lock.transfer_job_id = "export-job"
    local ok, err = w.locks.unlock_platform(3, nil, nil, nil, "export-job")
    assert(not ok and err:find("restored", 1, true), "a failed resolution snapshot released a quarantined copy")
    assert(lock.kind == "quarantine" and lock.quarantine.reason == "duplicate" and lock.transfer_job_id == nil and p.hidden)
    assert(w.locks.convert_for_resolution(3, "req-b"))
    assert(not w.locks.unlock_current_lock(3, lock), "a generic unlock released a converted quarantine")
    assert(lock.kind == "quarantine" and lock.resolution_restore == nil)
    local stone = w.tombstone(3, "retired-job")
    assert(w.locks.convert_for_resolution(3, "req-c"))
    stone.transfer_job_id = "export-job"
    assert(not w.locks.unlock_platform(3, nil, nil, nil, "export-job"))
    assert(stone.kind == "transfer" and stone.phase == "committed" and stone.transfer_job_id == "retired-job",
        "a failed resolution snapshot turned a tombstone into a releasable lock")
    local live = {kind = "transfer", phase = "pre_commit", transfer_job_id = "job-x", platform_uid = "old:30"}
    w.env.storage.locked_platforms[3] = live
    assert(not w.locks.convert_for_resolution(3, "req-d"), "an in-flight transfer lock was taken by a resolution")
    print("PASS a resolution snapshot converts a quarantine or tombstone and any failed unlock restores its protection")
end

do
    local w = world()
    local p = w.add(4, 40)
    local lock = w.quarantine(4, "rollback_other")
    local storage = w.env.storage
    assert(not w.locks.release_for_resolution(4, "missing"), "a release without a resolution token succeeded")
    storage.surface_export_resolutions = {tok = {platform_index = 4, platform_uid = "old:40", release = false}}
    assert(not w.locks.release_for_resolution(4, "tok"), "a deleting resolution released its platform")
    storage.surface_export_resolutions.tok = {platform_index = 5, platform_uid = "old:40", release = true}
    assert(not w.locks.release_for_resolution(4, "tok"), "a token for another platform released this one")
    storage.surface_export_resolutions.tok = {platform_index = 4, platform_uid = "other:40", release = true}
    assert(not w.locks.release_for_resolution(4, "tok"), "a token for another copy released this one")
    storage.surface_export_resolutions.tok = {platform_index = 4, platform_uid = "old:40", release = true}
    for _, state in ipairs({false, "unset"}) do
        storage.source_recovery_ready = state ~= "unset" and state or nil
        assert(not w.locks.release_for_resolution(4, "tok"), "a resolution released a platform before startup recovery was ready")
    end
    storage.source_recovery_ready = true
    assert(storage.locked_platforms[4] == lock and p.hidden)
    assert(w.locks.release_for_resolution(4, "tok"))
    assert(storage.locked_platforms[4] == nil and p.hidden == false)
    local q = w.add(5, 50)
    local stone = w.tombstone(5, "retired")
    assert(not w.locks.unlock_platform(5, nil, nil, nil, "retired"), "a tombstone was released without a resolution")
    storage.surface_export_resolutions.stone = {platform_index = 5, platform_uid = "old:50", release = true}
    assert(w.locks.release_for_resolution(5, "stone"), "an adopted tombstone could not be released with its token")
    assert(storage.locked_platforms[5] == nil and q.hidden == false and stone.kind == "transfer")
    print("PASS a quarantine or tombstone is released only with a matching resolution token after recovery is ready")
end

do
    local w = world()
    local p = w.add(6, 60)
    p.aboard = {{name = "pat"}, {name = "sam"}}
    w.quarantine(6, "duplicate", {lineage = "lineage:a:60"})
    w.env.storage.surface_export_lineages = {[6] = {lineage = "lineage:a:60", generation = 1, surface_index = 16, hub_unit_number = 60}}
    w.add(7, 70)
    w.tombstone(7, "retired-7")
    local listed = w.resolution.candidates()
    assert(listed.success and #listed.platforms == 2)
    local byIndex = {}
    for _, entry in ipairs(listed.platforms) do byIndex[entry.platformIndex] = entry end
    assert(byIndex[6].state == "quarantine" and byIndex[6].reason == "duplicate" and byIndex[6].passengers == 2
        and byIndex[6].lineage == "lineage:a:60" and byIndex[6].generation == 1 and byIndex[6].platformUid == "old:60")
    assert(byIndex[7].state == "tombstone" and byIndex[7].retiredExportId == "retired-7" and byIndex[7].reason == "duplicate")
    local first = w.apply({requestId = "req-del", step = "prepare_delete", platformIndex = 6, platformUid = "old:60"})
    assert(first.success and first.jobId == "export-job")
    local sent = w.queued[1]
    assert(sent.purpose == "resolution" and sent.destination == nil and sent.uid == "old:60" and sent.operation == "resolution:req-del")
    local again = w.apply({requestId = "req-del", step = "prepare_delete", platformIndex = 6, platformUid = "old:60"})
    assert(again.success and again.jobId == "export-job" and #w.queued == 1, "a retried prepare started a second snapshot")
    assert(not w.apply({requestId = "req-del", step = "prepare_delete", platformIndex = 7, platformUid = "old:70"}).success)
    assert(not w.apply({requestId = "req-del", step = "release", platformIndex = 6, platformUid = "old:60"}).success,
        "a deleting resolution released its own platform")
    assert(not w.locks.unlock_platform(6, nil, nil, nil, "export-job"), "the failed snapshot unlock released the copy")
    assert(w.env.storage.locked_platforms[6].kind == "quarantine", "a failed snapshot did not restore the quarantine")
    assert(not w.apply({requestId = "req-del", step = "release", platformIndex = 6, platformUid = "old:60"}).success and p.hidden,
        "a deleting resolution released its platform after its snapshot failed")
    w.set_queue(nil)
    local refused = w.apply({requestId = "req-t", step = "prepare_delete", platformIndex = 7, platformUid = "old:70"})
    assert(not refused.success and refused.error:find("refused", 1, true))
    local stone = w.env.storage.locked_platforms[7]
    assert(stone.kind == "transfer" and stone.phase == "committed" and stone.transfer_job_id == "retired-7" and not stone.resolution_restore,
        "a refused snapshot left a tombstone converted")
    assert(w.env.storage.surface_export_resolutions["req-t"] == nil)
    assert(not w.apply({requestId = "req-x", step = "prepare_delete", platformIndex = 7, platformUid = "wrong:70"}).success)
    print("PASS resolution candidates list quarantines and tombstones; prepare is idempotent and a refused snapshot restores protection")
end

do
    local w = world()
    local p = w.add(8, 80)
    w.quarantine(8, "rollback_other", {lineage = "lineage:a:80"})
    w.env.storage.surface_export_lineages = {[8] = {lineage = "lineage:a:80", generation = 1, surface_index = 18, hub_unit_number = 80}}
    local rival = w.add(9, 81)
    rival.hidden = false
    w.env.storage.surface_export_lineages[9] = {lineage = "lineage:a:80", generation = 3, surface_index = 19, hub_unit_number = 81}
    assert(not w.apply({requestId = "adopt-1", step = "release", platformIndex = 8, platformUid = "old:80", lineage = "lineage:a:80", generation = 4}).success,
        "a release without an authorized resolution succeeded")
    assert(w.authorize("adopt-1", 8, "old:80").success)
    assert(not w.apply({requestId = "adopt-1", step = "release", platformIndex = 8, platformUid = "old:80", lineage = "lineage:a:80", generation = 4,
        token = "another-token-0123456789abcdef0123"}).success, "a release with another token succeeded")
    local blocked = w.apply({requestId = "adopt-1", step = "release", platformIndex = 8, platformUid = "old:80", lineage = "lineage:a:80", generation = 4})
    assert(not blocked.success and p.hidden, "an adoption released a copy while another local copy carries its lineage")
    w.env.storage.surface_export_lineages[9] = nil
    w.env.storage.destination_holds = {incoming = {lineage = "lineage:a:80", generation = 3}}
    assert(not w.apply({requestId = "adopt-1", step = "release", platformIndex = 8, platformUid = "old:80", lineage = "lineage:a:80", generation = 4}).success,
        "an adoption released a copy while a destination hold carries its lineage")
    w.env.storage.destination_holds = nil
    local adopted = w.apply({requestId = "adopt-1", step = "release", platformIndex = 8, platformUid = "old:80", lineage = "lineage:a:80", generation = 4})
    assert(adopted.success and not p.hidden and w.env.storage.surface_export_lineages[8].generation == 4)
    assert(w.env.storage.source_recovery_notices[8] == nil)
    assert(w.apply({requestId = "adopt-1", step = "release", platformIndex = 8, platformUid = "old:80", lineage = "lineage:a:80", generation = 4}).success,
        "a retried release after a lost reply was refused")
    local q = w.add(10, 100)
    w.tombstone(10, "retired-10")
    w.env.storage.surface_export_lineages[10] = {lineage = "lineage:a:100", generation = 1, surface_index = 20, hub_unit_number = 100}
    assert(w.authorize("adopt-2", 10, "old:100").success)
    local revived = w.apply({requestId = "adopt-2", step = "release", platformIndex = 10, platformUid = "old:100", lineage = "lineage:a:100", generation = 2})
    assert(revived.success and not q.hidden and revived.platformUid == "boot-now:100", "an adopted tombstone kept its retired identity")
    local m = w.add(11, 110)
    w.quarantine(11, "legacy_unclassified")
    assert(not w.apply({requestId = "new-1", step = "mint", platformIndex = 11, platformUid = "old:110"}).success, "an unauthorized mint succeeded")
    assert(w.authorize("new-1", 11, "old:110").success)
    local minted = w.apply({requestId = "new-1", step = "mint", platformIndex = 11, platformUid = "old:110"})
    assert(minted.success and minted.lineage == "lineage:boot-now:110" and minted.generation == 0 and m.hidden,
        "minting a new platform released it before the registry claim")
    assert(w.apply({requestId = "new-1", step = "mint", platformIndex = 11, platformUid = "old:110"}).lineage == minted.lineage)
    assert(w.apply({requestId = "new-1", step = "release", platformIndex = 11, platformUid = "old:110", lineage = minted.lineage, generation = 0}).success)
    assert(not m.hidden and w.env.storage.locked_platforms[11] == nil)
    w.add(13, 130)
    assert(not w.authorize("new-2", 13, "old:130").success and not w.apply({requestId = "new-2", step = "mint", platformIndex = 13, platformUid = "old:130"}).success,
        "a usable platform was given a new lineage by a resolution")
    w.env.storage.source_recovery_ready = false
    assert(not w.apply({requestId = "late", step = "release", platformIndex = 8, platformUid = "old:80"}).success)
    print("PASS adoption and new-platform releases record the generation, refuse a second local copy and are idempotent")
end

do
    local minted
    for _, purpose in ipairs({"resolution", "download"}) do
        local stub = setmetatable({}, {__index = function() return noop end})
        local platform = {valid = true, index = 12, name = "legacy", paused = false,
            surface = {valid = true, index = 22, find_entities_filtered = function() return {} end}, hub = {valid = true, unit_number = 120}}
        local force = {name = "player", platforms = {[12] = platform}}
        local env = setmetatable({storage = {source_recovery_ready = true, source_recovery_epoch = "boot-now", async_job_id_counter = 0,
                async_jobs = {}}, game = {tick = 1, forces = {player = force}}, script = {active_mods = {base = "2.1.20"}}, log = noop},
            {__index = _G})
        local modules = {
            ["utils/game-utils"] = {platform_has_hub = function() return true end},
            ["utils/surface-lock"] = {lock_platform = function() return true end, get_lock_data = function() return nil end,
                destination_hold_owns_surface = function() return false end, DEFAULT_TRANSFER_LOCK_TTL_TICKS = 1},
            ["core/source-recovery"] = {platform_uid = function() return "old:120" end, export_job_id = function(n, name) return n .. "_" .. name end},
            ["utils/platform-schedule"] = {capture = function() return {} end, summarize = function() return {record_count = 0, interrupt_count = 0} end},
            ["export_scanners/tile_scanner"] = {scan_surface = function() return {} end},
            ["utils/util"] = {format_timestamp = function() return "t" end},
        }
        env.require = function(path)
            local name = path:match("^modules/surface_export/(.*)$")
            if name == "utils/platform-lineage" and not modules[name] then modules[name] = assert(loadfile(root .. name .. ".lua", "t", env))() end
            return name and modules[name] or stub
        end
        local pipeline = assert(loadfile(root .. "core/export-pipeline.lua", "t", env))()
        local job = assert(pipeline.queue(12, "player", "test", nil, nil, nil, "op", "old:120", nil, purpose ~= "download" and purpose or nil))
        local recorded = (env.storage.surface_export_lineages or {})[12]
        if purpose == "resolution" then
            assert(recorded == nil and env.storage.async_jobs[job].export_data.lineage == nil,
                "a resolution snapshot minted a lineage for a copy it is about to delete")
            assert(env.storage.async_jobs[job].purpose == "resolution")
        else
            minted = recorded and recorded.lineage
        end
    end
    assert(minted == "lineage:boot-now:120", "the control export did not mint a lineage")
    print("PASS a resolution snapshot reads the lineage without minting one")
end

do
    local w = world()
    local p = w.add(14, 140)
    p.aboard = {{name = "pat"}}
    w.quarantine(14, "duplicate", {lineage = "lineage:a:140"})
    w.env.storage.surface_export_lineages = {[14] = {lineage = "lineage:a:140", generation = 1, surface_index = 24, hub_unit_number = 140}}
    local prepared = w.apply({requestId = "keep-other", step = "prepare_delete", platformIndex = 14, platformUid = "old:140"})
    assert(prepared.success and w.env.storage.locked_platforms[14].transfer_job_id == "export-job")
    local delete = assert(loadfile(root .. "interfaces/remote/delete-platform-for-transfer.lua", "t", w.env))()
    assert(delete(14, "ship-14", "player", "export-job", "old:140") == "SUCCESS", "the resolution snapshot job could not delete its copy")
    assert(w.env.deleted == 1 and not p.valid and w.env.storage.locked_platforms[14] == nil)
    assert(w.env.evacuated and w.env.evacuated[1] == "pat", "players aboard the deleted copy were not evacuated")
    assert(w.env.storage.surface_export_lineages[14] == nil, "the deleted copy kept its lineage record")
    assert(w.env.storage.surface_export_transfer_receipts.source_deleted.records["export-job"], "no deletion receipt for a lost reply")
    assert(delete(14, "ship-14", "player", "export-job", "old:140") == "SUCCESS", "a retried deletion after a lost reply was refused")
    print("PASS keep-other: the resolution snapshot job deletes the stale copy through the source-delete path and evacuates players")
end

do
    local w = world()
    local p = w.add(15, 150)
    w.quarantine(15, "duplicate", {lineage = "lineage:a:150"})
    assert(w.apply({requestId = "abandon-1", step = "prepare_delete", platformIndex = 15, platformUid = "old:150"}).success)
    local lock = w.env.storage.locked_platforms[15]
    assert(lock.kind == "transfer" and lock.resolution_request_id == "abandon-1")
    local restored = w.apply({requestId = "abandon-1", step = "restore", platformIndex = 15, platformUid = "old:150"})
    assert(restored.success and lock.kind == "quarantine" and lock.quarantine.reason == "duplicate" and p.hidden,
        "an abandoned resolution left its copy under a releasable transfer lock")
    assert(w.apply({requestId = "abandon-1", step = "restore", platformIndex = 15, platformUid = "old:150"}).success, "a retried restore was refused")
    assert(lock.kind == "quarantine")
    local live = w.add(16, 160)
    live.hidden = false
    w.set_queue("export-live")
    assert(w.apply({requestId = "abandon-2", step = "prepare_delete", platformIndex = 16, platformUid = "old:160"}).success)
    w.env.storage.locked_platforms[16] = {kind = "transfer", phase = "pre_commit", transfer_job_id = "export-live", platform_name = "ship-16",
        force_name = "player", platform_index = 16, surface_index = 26, platform_uid = "old:160", frozen_states = {}, original_platform_hidden = false}
    live.hidden = true
    assert(w.apply({requestId = "abandon-2", step = "restore", platformIndex = 16, platformUid = "old:160"}).success)
    assert(w.env.storage.locked_platforms[16] == nil and live.hidden == false, "an abandoned keep-this left the other live copy locked")
    w.add(17, 170)
    w.quarantine(17, "duplicate")
    w.set_queue("export-job")
    assert(w.apply({requestId = "abandon-3", step = "prepare_delete", platformIndex = 17, platformUid = "old:170"}).success)
    w.env.storage.locked_platforms[17].phase = "committed"
    assert(not w.apply({requestId = "abandon-3", step = "restore", platformIndex = 17, platformUid = "old:170"}).success,
        "a committed deletion was abandoned")
    print("PASS an abandoned resolution restores the quarantine or releases the live copy it locked, never a committed deletion")
end

do
    local w = world()
    w.add(18, 180)
    w.tombstone(18, "retired-18")
    w.set_queue("snap-18")
    local retarget = {requestId = "retarget-1", step = "retarget", platformIndex = 18, platformUid = "old:180", exportId = "retired-18"}
    assert(not w.apply(retarget).success, "a copy was retargeted before its resolution held it")
    assert(w.apply({requestId = "retarget-1", step = "prepare_delete", platformIndex = 18, platformUid = "old:180"}).success)
    local lock = w.env.storage.locked_platforms[18]
    assert(lock.transfer_job_id == "snap-18")
    w.env.storage.async_jobs = {["snap-18"] = {}}
    assert(not w.apply(retarget).success, "a copy was retargeted while its snapshot was still running")
    w.env.storage.async_jobs = {}
    assert(not w.apply({requestId = "retarget-1", step = "retarget", platformIndex = 18, platformUid = "old:180", exportId = "another-job"}).success,
        "a retired copy was retargeted to another transfer's retirement")
    assert(not w.apply({requestId = "retarget-1", step = "retarget", platformIndex = 18, platformUid = "old:180", exportId = "retired-18",
        token = "wrong-token-0123456789abcdef0123456789"}).success, "retarget accepted another token")
    assert(w.apply(retarget).success)
    assert(lock.transfer_job_id == "retired-18" and lock.resolution_request_id == "retarget-1", "the deletion does not use the original retirement")
    assert(w.apply(retarget).success, "a retried retarget was refused")
    local restored = w.apply({requestId = "retarget-1", step = "restore", platformIndex = 18, platformUid = "old:180"})
    assert(restored.success and lock.kind == "transfer" and lock.phase == "committed" and lock.transfer_job_id == "retired-18"
        and lock.resolution_request_id == nil, "abandoning a retargeted tombstone did not restore the tombstone")
    w.add(19, 190)
    w.quarantine(19, "duplicate")
    assert(w.apply({requestId = "gone-1", step = "prepare_delete", platformIndex = 19, platformUid = "old:190"}).success)
    w.env.game.forces.player.platforms[19] = nil
    local gone = w.apply({requestId = "gone-1", step = "restore", platformIndex = 19, platformUid = "old:190"})
    assert(not gone.success and gone.committed == true, "abandoning a copy that no longer exists was reported as restored")
    print("PASS a journal-matched copy is deleted under its original retirement; abandon restores it and reports a finished deletion")
end

do
    local w = world()
    local p = w.add(20, 200)
    w.quarantine(20, "reconcile_error")
    local minted = w.lineage.mint_value("boot-now", p)
    assert(w.authorize("claim-1", 20, "old:200").success)
    assert(not w.apply({requestId = "claim-1", step = "release", platformIndex = 20, platformUid = "old:200", lineage = "lineage:boot-now:999", generation = 0}).success,
        "a release recorded a lineage the platform cannot mint")
    local released = w.apply({requestId = "claim-1", step = "release", platformIndex = 20, platformUid = "old:200", lineage = minted, generation = 0})
    assert(released.success, tostring(released.error))
    assert(w.lineage.get(p) == minted and w.env.storage.locked_platforms[20] == nil, "releasing an unminted claim did not record its lineage")
    print("PASS releasing an unminted claim records exactly the lineage the controller claimed")
end

do
    local w = world()
    w.add(21, 210)
    w.quarantine(21, "legacy_unclassified")
    assert(w.authorize("refresh-1", 21, "old:210").success)
    local released = w.apply({requestId = "refresh-1", step = "release", platformIndex = 21, platformUid = "old:210", refreshIdentity = true})
    assert(released.success and released.platformUid and released.platformUid ~= "old:210",
        "a released journal-matched copy kept the retired identity and would be tombstoned again at the next start")
    w.add(22, 220)
    w.quarantine(22, "reconcile_error")
    assert(w.authorize("refresh-2", 22, "old:220").success)
    local kept = w.apply({requestId = "refresh-2", step = "release", platformIndex = 22, platformUid = "old:220"})
    assert(kept.success and kept.platformUid == "old:220", "an ordinary release replaced the copy's identity")
    print("PASS releasing a journal-matched copy refreshes its identity; an ordinary release keeps it")
end
