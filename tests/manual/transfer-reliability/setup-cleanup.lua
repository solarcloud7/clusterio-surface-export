return function(action, name)
    local function module(path)
        return assert(package.loaded['__level__/modules/surface_export/' .. path .. '.lua'], path .. ' not loaded')
    end
    local pipeline = module('core/import-pipeline')
    local holds = module('core/destination-hold')
    local schedule = module('utils/platform-schedule')
    local utils = module('utils/game-utils')
    local processor = module('core/async-processor')
    if action == 'fail' then
        assert(next(storage.async_jobs) == nil and next(storage.locked_platforms or {}) == nil
            and next(storage.destination_holds or {}) == nil, 'fixture requires idle owned world')
        local original_apply, original_delete = schedule.apply, utils.delete_platform
        local deletes = 0
        schedule.apply = function() return false, 'injected preparation refusal' end
        utils.delete_platform = function() deletes = deletes + 1; return false end
        local ok, result = pcall(function()
            local input = {schema_version='2.0.0', factorio_version='2.1.17', _transferId=name,
                platform={schedule={current=1,records={},interrupts={}}}, entities={}, tiles={},
                verification={item_counts={},fluid_counts={}}}
            local id, err = pipeline.queue(input, name, 'player', 'RCON')
            assert(not id and err:find('injected preparation refusal', 1, true), tostring(err))
            local job_id, job = next(storage.async_jobs)
            assert(job and job.setup_cleanup, 'failed setup is untracked')
            local p = assert(game.forces.player.platforms[job.setup_cleanup.platform_index])
            local h = assert(holds.get(name))
            assert(h.preparation_failed and p.hidden and p.paused
                and game.forces.player.get_surface_hidden(p.surface), 'destination is not protected')
            assert(job.target_surface.index == p.surface.index, 'preparation lost surface identity')
            assert(not holds.go_live(name), 'failed setup can activate')
            local cargo = p.hub.get_inventory(defines.inventory.hub_main).get_contents()
            assert(next(cargo) == nil, 'starter cargo leaked into failed import')
            assert(not pipeline.queue(input, name, 'player', 'RCON'), 'duplicate import was accepted')
            local count = 0
            for _, candidate in pairs(game.forces.player.platforms) do
                if candidate.name:sub(1,#name) == name then count=count+1 end
            end
            assert(count == 1 and deletes == 1, 'duplicate created a platform or repeated deletion')
            -- Keep the recorded cleanup pending while the runner saves and reloads this world.
            job.setup_cleanup.next_tick = game.tick + 36000
            return {success=true,job=job_id,platform=p.index,surface=p.surface.index,
                tick=game.tick,engine=script.active_mods.base,protected=true,starterCargo=cargo,
                error=err,status=processor.get_job_status(job_id)}
        end)
        schedule.apply, utils.delete_platform = original_apply, original_delete
        assert(ok, result)
        return result
    elseif action == 'retry' then
        local job = assert(storage.async_jobs[name], 'cleanup job did not survive save/reload')
        assert(job.setup_cleanup and job.completion_interrupted, 'cleanup state did not survive')
        local h = assert(holds.get(job.setup_cleanup.hold_id), 'quarantine did not survive')
        local p = assert(game.forces.player.platforms[h.platform_index])
        assert(p.hidden and p.paused and h.preparation_failed, 'quarantine is releasable after reload')
        job.setup_cleanup.next_tick = game.tick
        return {success=true,tick=game.tick,platform=p.index,surface=p.surface.index}
    elseif action == 'inspect' then
        return {success=true,pending=storage.async_jobs[name]~=nil,result=storage.async_job_results[name],
            holds=storage.destination_holds or {},tick=game.tick}
    elseif action == 'controls' then
        local config = assert(storage.surface_export_config)
        local old_debug, old_sync = config.debug_mode, processor.get_sync_mode()
        local old_exports, old_locks = storage.platform_exports, storage.locked_platforms
        local ok, result = pcall(function()
            config.debug_mode=false
            local enabled, err=pcall(processor.set_sync_mode,true)
            assert(not enabled and tostring(err):find('debug_mode') and not processor.get_sync_mode())
            config.debug_mode=true; processor.set_sync_mode(true)
            assert(processor.get_sync_mode())
            config.debug_mode=false; assert(not processor.get_sync_mode())
            storage.platform_exports={pending={tick=1},committed={tick=2},unused={tick=3}}
            storage.locked_platforms={{transfer_job_id='pending',committed_transfer_id='committed'}}
            local removed=remote.call('surface_export','clear_old_exports',0)
            assert(removed==1 and storage.platform_exports.pending and storage.platform_exports.committed
                and not storage.platform_exports.unused, 'manual cleanup removed a protected export')
            return {success=true,debugGate=true,manualCacheProtection=true}
        end)
        storage.platform_exports, storage.locked_platforms=old_exports,old_locks
        config.debug_mode=old_debug; processor.set_sync_mode(old_sync)
        assert(ok,result)
        return result
    end
    error('unknown fixture action')
end
