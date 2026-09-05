local GameUtils = require("modules/surface_export/utils/game-utils")
local Deserializer = require("modules/surface_export/core/deserializer")

local ActiveStateRestoration = {}

ActiveStateRestoration.MINING_PROGRESS_BUDGET_TICKS = 300

local ACTIVATABLE_ENTITY_TYPES = GameUtils.ACTIVATABLE_ENTITY_TYPES

local function restore_inserter_held(entity, entity_data)
    if entity.type ~= "inserter" then return 0, 0 end
    local sd = entity_data.specific_data
    if not (sd and sd.held_item and entity.held_stack) then return 0, 0 end
    local want = sd.held_item.count or 1
    local have = entity.held_stack.valid_for_read and entity.held_stack.count or 0
    if have >= want then return have, 0 end
    local ok, err = pcall(function() entity.held_stack.set_stack(sd.held_item) end)
    if not ok then
        log(string.format("[Import] Failed to restore held item '%s' x%d for inserter: %s",
            sd.held_item.name or "?", want, tostring(err)))
    end
    local got = entity.held_stack.valid_for_read and entity.held_stack.count or 0
    if got < have then got = have end
    return got, math.max(0, want - got)
end

function ActiveStateRestoration.restore_held_items_only(entities_to_create, entity_map)
    local restored = 0
    local failed = 0
    for _, entity_data in ipairs(entities_to_create) do
        local entity = entity_map[entity_data.entity_id]
        if entity and entity.valid and entity.type == "inserter"
           and entity_data.specific_data
           and entity_data.specific_data.held_item
           and entity.held_stack then
            local want = entity_data.specific_data.held_item.count or 1
            local have = entity.held_stack.valid_for_read and entity.held_stack.count or 0
            if have < want then
                local got, short = restore_inserter_held(entity, entity_data)
                restored = restored + math.max(0, got - have)
                failed = failed + short
            end
        end
    end
    if restored > 0 or failed > 0 then
        log(string.format("[Import] Pre-validation held-item restore: %d restored, %d failed (machines stay inactive)",
            restored, failed))
    end
    return restored, failed
end

function ActiveStateRestoration.queue_mining_progress(entity, sd)
    storage.pending_mining_progress = storage.pending_mining_progress or {}
    storage.pending_mining_progress[#storage.pending_mining_progress + 1] = {
        entity = entity,
        mining_progress = sd.mining_progress,
        bonus_mining_progress = sd.bonus_mining_progress,
        expires_tick = game.tick + ActiveStateRestoration.MINING_PROGRESS_BUDGET_TICKS,
    }
end

function ActiveStateRestoration.has_resource_in_mining_area(entity)
    local ok, found = pcall(function()
        local radius = entity.prototype.mining_drill_radius or 0
        local pos = entity.position
        return entity.surface.count_entities_filtered{
            type = "resource",
            area = { { pos.x - radius, pos.y - radius }, { pos.x + radius, pos.y + radius } },
        } > 0
    end)
    if not ok then
        log(string.format("[Import] resource scan under '%s' failed (record kept): %s",
            tostring(entity.name), tostring(found)))
        return true
    end
    return found
end

function ActiveStateRestoration.service_pending_mining_progress()
    local pending = storage.pending_mining_progress
    if not pending or #pending == 0 then return end
    local budget = ActiveStateRestoration.MINING_PROGRESS_BUDGET_TICKS
    local keep = {}
    for _, rec in ipairs(pending) do
        local done = true
        if not (rec.entity and rec.entity.valid) then
            log(string.format("[Import] deferred mining_progress DROPPED: entity invalid (captured %s)",
                tostring(rec.mining_progress)))
        else
            local ok, bound = pcall(function() return rec.entity.mining_target ~= nil end)
            if ok and bound then
                for _, field in ipairs({ "mining_progress", "bonus_mining_progress" }) do
                    if rec[field] then
                        local w_ok, w_err = pcall(function() rec.entity[field] = rec[field] end)
                        if not w_ok then
                            log(string.format("[Import] deferred %s write failed for '%s': %s",
                                field, tostring(rec.entity.name), tostring(w_err)))
                        end
                    end
                end
            else
                local active_ok, is_active = pcall(function() return rec.entity.active end)
                if active_ok and is_active == false then
                    if ActiveStateRestoration.has_resource_in_mining_area(rec.entity) then
                        rec.expires_tick = game.tick + budget
                        done = false
                    else
                        log(string.format(
                            "[Import] deactivated '%s' on '%s' has no resource in its mining area — captured mining_progress %s DROPPED",
                            tostring(rec.entity.name), tostring(rec.entity.surface.name), tostring(rec.mining_progress)))
                    end
                elseif game.tick < rec.expires_tick then
                    done = false
                else
                    log(string.format(
                        "[Import] mining_target never bound for '%s' on '%s' within %d ticks — captured mining_progress %s DROPPED",
                        tostring(rec.entity.name), tostring(rec.entity.surface.name), budget, tostring(rec.mining_progress)))
                end
            end
        end
        if not done then keep[#keep + 1] = rec end
    end
    storage.pending_mining_progress = (#keep > 0) and keep or nil
end

function ActiveStateRestoration.restore(entities_to_create, entity_map, frozen_states)
    log("[Import] Restoring original active states (final step)...")
    frozen_states = frozen_states or {}
    
    local activated_count = 0
    local kept_inactive_count = 0
    local skipped_count = 0
    local held_items_restored = 0
    local held_items_failed = 0
    
    for _, entity_data in ipairs(entities_to_create) do
        local entity = entity_map[entity_data.entity_id]
        
        if not entity or not entity.valid then
            goto continue
        end
        
        
        local was_active = frozen_states[entity_data.entity_id]
        if was_active == nil and entity_data.entity_id ~= nil then
            was_active = frozen_states[tostring(entity_data.entity_id)]
        end

        if was_active == nil then
            was_active = true
        end
        
        local read_ok, is_active = pcall(function() return entity.active end)
        if not read_ok or is_active == nil then
            skipped_count = skipped_count + 1
            goto continue
        end

        if was_active then
            if not is_active then
                local wake_ok, wake_err = pcall(function() entity.disabled_by_script = false end)
                if wake_ok then
                    activated_count = activated_count + 1
                else
                    log(string.format("[Import] activate failed for '%s': %s",
                        tostring(entity.name), tostring(wake_err)))
                end
            end

            local restored, failed = restore_inserter_held(entity, entity_data)
            held_items_restored = held_items_restored + restored
            held_items_failed = held_items_failed + failed
        else
            if entity.type == "inserter"
               and entity_data.specific_data
               and entity_data.specific_data.held_item
               and entity.held_stack
               and not entity.held_stack.valid_for_read then
                local restored, failed = restore_inserter_held(entity, entity_data)
                held_items_restored = held_items_restored + restored
                held_items_failed = held_items_failed + failed
            end

            if is_active then
                local off_ok, off_err = pcall(function() entity.disabled_by_script = true end)
                if not off_ok then
                    log(string.format("[Import] keep-inactive failed for '%s': %s",
                        tostring(entity.name), tostring(off_err)))
                end
            end
            kept_inactive_count = kept_inactive_count + 1
        end

        local sd = entity_data.specific_data
        if sd and sd.mining_progress and entity.type == "mining-drill" then
            ActiveStateRestoration.queue_mining_progress(entity, sd)
        end
        
        ::continue::
    end
    
    log(string.format("[Import] Active state restoration complete: %d activated, %d kept inactive, %d skipped, held items: %d restored / %d failed",
        activated_count, kept_inactive_count, skipped_count, held_items_restored, held_items_failed))

    if activated_count > 0 then
        game.print(string.format("[Import] Activated %d entities (restored to original state)", activated_count), {0, 1, 0})
    end

    local segmented_units = 0
    for _, entity_data in ipairs(entities_to_create) do
        local wanted = entity_data.specific_data and entity_data.specific_data.segmented_unit
        local entity = wanted and entity_map[entity_data.entity_id]
        if wanted and entity and entity.valid
           and Deserializer.restore_segmented_unit_state(entity, wanted) then
            segmented_units = segmented_units + 1
        end
    end
    if segmented_units > 0 then
        log(string.format("[Import] Segmented-unit activity mode re-asserted after activation for %d unit(s)",
            segmented_units))
    end
end

return ActiveStateRestoration
