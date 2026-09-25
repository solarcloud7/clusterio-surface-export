local root = "docker/seed-data/external_plugins/surface_export/module/"
local function noop() end
local function fixture(fault, deletion)
    local platforms, created, deletes = {}, 0, 0
    local force = {valid = true, name = "player", platforms = platforms,
        get_surface_hidden = function() return false end, set_surface_hidden = noop}
    local modules, platform = {}, nil
    local stub = setmetatable({}, {__index = function() return noop end})
    local env = setmetatable({storage = {async_jobs = {}, async_job_results = {}, async_job_id_counter = 0},
        log = noop, game = {tick = 10, print = noop, forces = {player = force}, connected_players = {}},
        defines = {inventory = {hub_main = 1},events=setmetatable({}, {__index=function(_, key) return key end})}}, {__index = _G})
    force.create_space_platform = function(options)
        created = created + 1
        local hub = {valid = true, unit_number = created + 100, name = "space-platform-hub", type = "space-platform-hub", position = {x=0,y=0},
            get_inventory = function() return {clear = noop} end}
        local surface = {valid = true, index = created + 20, find_entities_filtered = function()
            if fault == "scan" then error("injected scan failure") end
            return {hub}
        end}
        platform = {valid = true, index = created, name = options.name, force = force,
            hub = hub, hidden = false, paused = false, apply_starter_pack = function()
                if fault == "before_surface" then error("injected failure before surface creation") end
                platform.surface = surface
                env.storage.source_recovery_surface_epochs = {[surface.index] = "fixture"}
                if fault == "missing_hub" then platform.hub = nil; error("injected missing hub") end
                if fault == "starter" then error("injected starter failure") end
            end}
        platforms[created] = platform
        return platform
    end
    modules['core/gateway'] = {evacuate_passengers = function() return {success=true,failures=0} end}
    modules['utils/game-utils'] = {ACTIVATABLE_ENTITY_TYPES = {}, delete_platform = function(target)
        deletes = deletes + 1
        if deletion == "throw" then error("injected deletion error") end
        if deletion ~= "success" then return false end
        target.valid = false; target.surface.valid = false; platforms[target.index] = nil; return true
    end}
    modules['utils/surface-lock'] = {
        get_lock_data=function(index) return (env.storage.locked_platforms or {})[index] end,
        destination_hold_owns_surface=function() return false end,
        lock_platform=function(p, f, opts)
            env.storage.locked_platforms=env.storage.locked_platforms or {}
            env.storage.locked_platforms[p.index]={kind=opts.kind,force_name=f.name,surface_index=p.surface.index}
            p.hidden=true;return true
        end,
        complete_cargo_pods = function() return 0, 0, 0 end}
    modules['utils/operation-timing'] = setmetatable({scope = function(_, _, fn, ...) return fn(...) end}, {__index = function() return noop end})
    modules['utils/version-compat'] = {parse = function() return {bucket = "2.1"} end,
        runtime_bucket = function() return "2.1" end, migrate = function(value) return value end,
        check_payload_schema = function() return true end}
    modules['utils/platform-schedule'] = {validate_transfer_payload = function() return true end,
        filter_for_import = function(value) return value end, apply = function()
            if fault == "schedule_throw" then error("injected schedule error") end
            return fault ~= "schedule", "injected schedule refusal"
        end, summarize = function() return {record_count=0,interrupt_count=0} end}
    modules['core/import-target'] = {resolve = function() return "nauvis" end}
    modules['utils/util'] = {sum_items = function()
        if fault == "totals" then error("injected totals error") end; return 0
    end, sum_fluids = function() return 0 end}
    local real = {['control']=true,['core/source-recovery']=true,['utils/platform-identity']=true,['core/destination-hold']=true,['core/import-pipeline']=true,['core/import-completion']=true,
        ['utils/transfer-receipts']=true,['core/async-processor']=true,['core/job-results']=true,['core/job-status']=true}
    env.require = function(path)
        if path == 'modules/clusterio/api' then return {events={on_server_startup='startup',on_instance_updated='updated'},send_json=noop} end
        local key = path:match('^modules/surface_export/(.*)$')
        if real[key] and not modules[key] then modules[key] = assert(loadfile(root .. key .. '.lua', 't', env))() end
        return modules[key] or stub
    end
    local function load(key) return env.require('modules/surface_export/' .. key) end
    return {env=env, load=load, stats=function() return created,deletes,platform end,
        allow=function() deletion="success" end, reload=function() modules['core/async-processor']=nil;modules['core/import-pipeline']=nil end}
end
local function payload(transfer)
    return {_transferId=transfer,platform={schedule={records={}}},verification={item_counts={},fluid_counts={}},entities={}}
end
local invalid=fixture(nil,'success')
local invalid_id,invalid_error=invalid.load('core/import-pipeline').queue(42,'fixture','player','RCON')
assert(not invalid_id and invalid_error:find('JSON object',1,true))
assert(invalid.stats()==0 and next(invalid.env.storage.async_jobs)==nil,
    'scalar JSON must be rejected before creating a platform or cleanup job')
for _, fault in ipairs({'starter','scan','schedule','schedule_throw','totals'}) do
  for _, deletion in ipairs({'false','throw','success'}) do
    for _, transfer in ipairs({'transfer',false}) do
        local f=fixture(fault,deletion)
        local input=payload(transfer or nil)
        local id,err=f.load('core/import-pipeline').queue(input,'fixture','player','RCON')
        local _,attempts,platform=f.stats()
        assert(not id and err, "failed setup queued normal import")
        assert(attempts==1, "setup failure did not attempt cleanup exactly once")
        if deletion=='success' then
            assert(not platform.valid and next(f.env.storage.async_jobs)==nil)
        else
            local _,job=next(f.env.storage.async_jobs)
            assert(job and job.setup_cleanup and job.completion_interrupted, "refused deletion orphaned the new platform")
            assert(job.target_platform==platform and job.setup_cleanup.error, "lost cleanup identity or original failure")
            local hold=f.load('core/destination-hold').get(job.setup_cleanup.hold_id)
            assert(hold and hold.preparation_failed and platform.hidden and platform.paused, "failed setup escaped quarantine")
            assert(not f.load('core/destination-hold').go_live(job.setup_cleanup.hold_id), "unvalidated setup could activate")
            local scheduler=f.load('core/async-processor')
            f.env.game.tick=job.setup_cleanup.next_tick-1;scheduler.process_tick()
            local _,before=f.stats();assert(before==1,"cleanup ignored retry backoff")
            if transfer then
                assert(not f.load('core/import-pipeline').queue(input,'fixture','player','RCON'))
                local count=f.stats();assert(count==1,"replay created a second platform during cleanup")
            end
            f.allow();f.reload()
            f.env.game.tick=job.setup_cleanup.next_tick
            f.load('core/async-processor').process_tick()
            assert(not platform.valid and not f.env.storage.async_jobs[job.job_id], "cleanup did not recover after reload")
            assert(not f.load('core/destination-hold').get(job.setup_cleanup.hold_id), "successful cleanup retained hold")
            local result=f.env.storage.async_job_results[job.job_id]
            assert(result and result.status=='failed' and result.validation.success==false, "cleanup relabeled failed import as success")
        end
    end
  end
end
print('PASS failed setup retains quarantine, retries with backoff across reload, and never activates or replays creation')

local f=fixture('starter','false')
f.load('core/import-pipeline').queue(payload('changed'),'fixture','player','RCON')
local _,job=next(f.env.storage.async_jobs)
job.target_platform.surface={valid=true,index=999}
f.allow();f.env.game.tick=job.setup_cleanup.next_tick;f.load('core/async-processor').process_tick()
local _,attempts=f.stats()
assert(attempts==1 and f.env.storage.async_jobs[job.job_id], 'cleanup deleted a changed surface')
print('PASS cleanup refuses a changed platform surface')

for _, deletion in ipairs({'false','success'}) do
    local pending_fixture=fixture('schedule',deletion)
    local pending={type='import',job_id='import_7',started_tick=1,platform_name='fixture',
        force_name='player',setup_pending=true,decoded_data=payload('sectional')}
    pending_fixture.env.storage.async_jobs[pending.job_id]=pending
    pending_fixture.load('core/import-pipeline').process_setup(pending)
    if deletion=='false' then
        assert(pending_fixture.env.storage.async_jobs[pending.job_id]==pending and pending.setup_cleanup,
            'sectional setup lost its existing job identity')
        local status=pending_fixture.load('core/async-processor').get_job_status(pending.job_id)
        assert(status.state=='cleanup-pending' and status.error)
    else
        assert(not pending_fixture.env.storage.async_jobs[pending.job_id])
        assert(pending_fixture.env.storage.async_job_results[pending.job_id].status=='failed')
        local result=pending_fixture.env.storage.async_job_results[pending.job_id]
        assert(result.completion.success==false and result.completion.validation==result.validation,
            'completed cleanup lost the original failed verdict needed by status reconciliation')
    end
end
print('PASS sectional preparation retains its job ID and exposes failed cleanup status')

local shared=fixture('schedule','false')
shared.load('core/import-pipeline').queue(payload('shared'),'fixture','player','RCON')
local _,cleanup_job=next(shared.env.storage.async_jobs)
shared.env.storage.async_jobs.export={type='export',job_id='export',started_tick=0,last_step_tick=-2}
shared.allow();shared.env.game.tick=cleanup_job.setup_cleanup.next_tick
shared.load('core/async-processor').process_tick()
local _,attempt_count=shared.stats();assert(attempt_count==1,'cleanup exceeded the shared step budget')
shared.env.game.tick=shared.env.game.tick+1
shared.load('core/async-processor').process_tick()
assert(not shared.env.storage.async_jobs[cleanup_job.job_id], 'normal export starved cleanup')
print('PASS cleanup shares the import/export step budget without starvation')

local successful=fixture(nil,'false')
local successful_id=successful.load('core/import-pipeline').queue(payload('successful'),'fixture','player','RCON')
local _,successful_deletes=successful.stats()
assert(successful_id and successful.env.storage.async_jobs[successful_id] and successful_deletes==0)
assert(not successful.env.storage.async_jobs[successful_id].setup_cleanup)
print('PASS successful setup queues normally and never attempts deletion')

local unbuilt=fixture('before_surface','success')
unbuilt.load('core/import-pipeline').queue(payload('unbuilt'),'fixture','player','RCON')
local _,unbuilt_job=next(unbuilt.env.storage.async_jobs)
assert(unbuilt_job and unbuilt_job.setup_cleanup and not unbuilt_job.target_surface,
    'failure before surface creation lost the platform record')
assert(not unbuilt.load('core/destination-hold').go_live('unbuilt'))
unbuilt.env.game.tick=unbuilt_job.setup_cleanup.next_tick
unbuilt.load('core/async-processor').process_tick()
local _,unbuilt_deletes=unbuilt.stats()
assert(unbuilt_deletes==0 and unbuilt.env.storage.async_jobs[unbuilt_job.job_id],
    'cleanup invented a removable surface or lost the unresolved platform')
print('PASS failure before surface creation retains an unresolved job without inventing a removable surface')

local merged=fixture('schedule','false')
merged.load('core/import-pipeline').queue(payload('merge'),'fixture','player','RCON')
local _,merge_job=next(merged.env.storage.async_jobs)
local merge_platform=merge_job.target_platform
local original_force=merged.env.game.forces.player
local replacement_force={valid=true,name='merged',platforms={[merge_platform.index]=merge_platform}}
original_force.platforms[merge_platform.index]=nil
merged.env.game.forces.merged=replacement_force
merge_platform.force=replacement_force
merged.allow();merged.env.game.tick=merge_job.setup_cleanup.next_tick
merged.load('core/async-processor').process_tick()
assert(merge_platform.valid and merged.env.storage.async_jobs[merge_job.job_id]==merge_job,
    'cleanup lost a surviving platform after its force changed')
assert(merged.load('core/destination-hold').get('merge'), 'cleanup dropped the unresolved hold')
local _,merge_deletes=merged.stats();assert(merge_deletes==1, 'cleanup deleted across a changed force')
assert(not merged.env.storage.async_job_results[merge_job.job_id], 'cleanup claimed completion without deletion')
print('PASS changed force retains cleanup ownership instead of mistaking a roster miss for deletion')

local missing=fixture('missing_hub','false')
missing.load('core/import-pipeline').queue(payload('no-hub'),'fixture','player','RCON')
local _,missing_job=next(missing.env.storage.async_jobs)
local _,first_delete,missing_platform=missing.stats()
assert(first_delete==1 and missing_job and not missing_platform.hub)
assert(missing_platform.hidden and missing_platform.paused, 'missing hub escaped basic quarantine')
assert(not missing.load('core/destination-hold').get('no-hub'), 'missing identity manufactured a remote hold')
missing.env.storage.destination_holds['no-hub']={transfer_id='no-hub',preparation_failed=true,
    platform_index=missing_platform.index,surface_index=missing_platform.surface.index,force_name='player'}
missing.reload()
local recovery=missing.load('core/source-recovery')
recovery.startup()
assert(not recovery.begin('new-boot','journal',false).success, 'unidentified setup unexpectedly reconciled')
local waiting_export={type='export',job_id='must-wait',started_tick=0}
missing.env.storage.async_jobs[waiting_export.job_id]=waiting_export
missing.allow();missing.env.game.tick=missing_job.setup_cleanup.next_tick
missing.load('control').events.on_tick()
assert(not waiting_export.last_step_tick, 'normal export ran before recovery')
assert(not missing.load('core/destination-hold').get('no-hub'), 'deleted setup retained its legacy hold')
assert(recovery.begin('new-boot','journal',false).success and recovery.finish().success,
    'deleted setup left bootstrap permanently blocked')
local _,retry_delete=missing.stats()
assert(retry_delete==2 and not missing_platform.valid and not missing.env.storage.async_jobs[missing_job.job_id],
    'exact setup references did not permit cleanup after a missing-hub failure')
print('PASS missing-hub setup deletion retries across reload through exact saved job references')
