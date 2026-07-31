-- Active State Restoration Phase
-- Final import step: Restore entities to their original active state
--
-- This is the "Wake Up" signal - the LAST phase of import.
-- By this point, all geometry is placed, fluids/belts are hydrated,
-- and circuit wires are connected. Entities wake up to a "ready" environment.

local GameUtils = require("modules/surface_export/utils/game-utils")

local ActiveStateRestoration = {}

local ACTIVATABLE_ENTITY_TYPES = GameUtils.ACTIVATABLE_ENTITY_TYPES

--- Restore an inserter's held item from its serialized data.
--- Works regardless of entity.active — set_stack seating is ACTIVATION-INDEPENDENT
---: a deactivated inserter (fresh or settled)
--- seats fully when force capacity allows, and at bonus 0 it clamps identically active or
--- inactive. (The old "silently fails on a settled-deactivated inserter" claim was refuted;
--- the historical missing-held phantom was the deserializer's DEAD held-restore — stranded
--- behind its has_inventories early-return — plus the force-bonus clamp of inserter hand capacity is governed by the DEST force's research.)
--- No-op (returns 0,0) for non-inserters, missing data, or an already-restored hand.
--- @param entity LuaEntity
--- @param entity_data table
--- @return number, number: items restored, items failed
local function restore_inserter_held(entity, entity_data)
    if entity.type ~= "inserter" then return 0, 0 end
    local sd = entity_data.specific_data
    if not (sd and sd.held_item and entity.held_stack) then return 0, 0 end
    local want = sd.held_item.count or 1
    local have = entity.held_stack.valid_for_read and entity.held_stack.count or 0
    if have >= want then return have, 0 end                    -- already satisfied (idempotent top-up)
    -- set_stack REPLACES the hand, so this tops up a PARTIALLY-filled hand too (the busy-loss case:
    -- a hand clamped short by an under-researched dest force before the Phase-0 bonus sync existed).
    -- The bool lies, so we read back and return the genuine shortfall (a VISIBLE loss, not silent).
    local ok, err = pcall(function() entity.held_stack.set_stack(sd.held_item) end)
    if not ok then
        log(string.format("[Import] Failed to restore held item '%s' x%d for inserter: %s",
            sd.held_item.name or "?", want, tostring(err)))
    end
    -- set_stack seats up to the inserter's CURRENT hand capacity, which is governed by the destination FORCE's
    -- inserter-capacity research (bulk_inserter_capacity_bonus / inserter_stack_size_bonus). That bonus is now
    -- synced from the source force BEFORE hydration (import-pipeline Phase 0), so a legally-captured amount
    -- seats in full. A direct `held_stack.count = want` write does NOT bypass this — it clamps to the same
    -- capacity (verified on 2.0.76: at bonus 0, count=8 → 1). That earlier "no-cap" write was a disproven
    -- dead-end and was removed. The set_stack bool lies, so we read back and return any genuine shortfall as a
    -- VISIBLE loss (never silent).
    local got = entity.held_stack.valid_for_read and entity.held_stack.count or 0
    if got < have then got = have end                          -- never report worse than before the call
    return got, math.max(0, want - got)
end

--- Restore inserter held items with every machine still deactivated (pre-validation pass).
--- This pass is the SINGLE OWNER of held-item seating: the deserializer's old held-restore was
--- dead code (stranded behind restore_inventories' has_inventories early-return, unreachable for
--- every bare inserter), so held items were never restored anywhere else — THAT, plus the
--- force-bonus clamp (dest-force research governs hand capacity), was the real
--- "held phantom" at the gate. Running this pass synchronously before validation lets the STRICT
--- gate count a COMPLETE state without opening a craft window (the gate counts BEFORE activation: machines must stay
--- inactive through validation so they cannot consume/produce between activation and counting).
--- No activation is needed for seating — set_stack is ACTIVATION-INDEPENDENT
---; the former wake-toggle ritual was removed.
--- Idempotent with restore(): its top-up guard makes the later held-restore a no-op for hands
--- filled here.
--- @param entities_to_create table: List of entity data objects
--- @param entity_map table: Map of entity_id to LuaEntity
--- @return number, number: items restored, items failed
function ActiveStateRestoration.restore_held_items_only(entities_to_create, entity_map)
    local restored = 0
    local failed = 0
    for _, entity_data in ipairs(entities_to_create) do
        local entity = entity_map[entity_data.entity_id]
        if entity and entity.valid and entity.type == "inserter"
           and entity_data.specific_data
           and entity_data.specific_data.held_item
           and entity.held_stack then
            -- Trigger on EMPTY *or* PARTIALLY-filled hands (have < captured), not only empty. A hand can
            -- arrive partial when the dest force's capacity clamped it before the Phase-0 bonus sync ran
            -- (inserter hand capacity is governed by the DEST force's research) — the old `not valid_for_read` (empty-only) guard skipped those, so they were
            -- never topped up and vanished silently. Verified: src-held 80 -> dest-held 33 == gate loss 47.
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

--- Queue a mining drill's captured progress for a DEFERRED write once its mining_target binds.
--- Why deferred (the LuaControl clause this whole bug hid behind): mining_progress for drills is
--- in range [0, mining_target.prototype.mineable_properties.mining_time] — defined relative to a
--- target that is READ-ONLY and nil until the drill's first update. A pre-update write is
--- unanchored and lost at cycle start; a post-binding write sticks (both measured 2026-07-29).
--- @param entity LuaEntity: a mining drill, already woken
--- @param sd table: the entity's specific_data carrying mining_progress / bonus_mining_progress
function ActiveStateRestoration.queue_mining_progress(entity, sd)
    storage.pending_mining_progress = storage.pending_mining_progress or {}
    storage.pending_mining_progress[#storage.pending_mining_progress + 1] = {
        entity = entity,
        mining_progress = sd.mining_progress,
        bonus_mining_progress = sd.bonus_mining_progress,
        expires_tick = game.tick + 300,
    }
end

--- Service the deferred queue (called from AsyncProcessor.process_tick — on_tick context, so every
--- failure is logged, never thrown: a raw error() here kills the headless server). Each entry
--- writes as soon as its drill has a bound mining_target; an entry whose target never binds within
--- its window is dropped LOUDLY, not silently.
function ActiveStateRestoration.service_pending_mining_progress()
    local pending = storage.pending_mining_progress
    if not pending or #pending == 0 then return end
    local keep = {}
    for _, rec in ipairs(pending) do
        local done = true
        if not (rec.entity and rec.entity.valid) then
            -- Loud, not silent (review 2026-07-30): an invalid entity here means the drill was
            -- destroyed (or the ref crossed a save/load) before its progress could land.
            log(string.format("[Import] deferred mining_progress DROPPED: entity invalid (captured %s)",
                tostring(rec.mining_progress)))
        elseif rec.entity and rec.entity.valid then
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
            elseif game.tick < rec.expires_tick then
                done = false
            else
                -- PAUSE-AWARE expiry (review 2026-07-30): a paused platform's drills never update,
                -- so mining_target cannot bind — the gateway-park path re-pauses right after
                -- activation and would otherwise burn the whole window and DROP the captured
                -- progress before the player ever resumes. Slide the window while paused; the
                -- clock only runs against an unpaused platform that genuinely failed to bind.
                local paused_ok, is_paused = pcall(function()
                    return rec.entity.surface.platform and rec.entity.surface.platform.paused
                end)
                if paused_ok and is_paused then
                    rec.expires_tick = game.tick + 300
                    done = false
                else
                    log(string.format(
                        "[Import] mining_target never bound for '%s' within %d ticks — captured mining_progress %s DROPPED",
                        tostring(rec.entity.name), 300, tostring(rec.mining_progress)))
                end
            end
        end
        if not done then keep[#keep + 1] = rec end
    end
    storage.pending_mining_progress = (#keep > 0) and keep or nil
end

--- Restore all entities to their original active state
--- This is the FINAL step of import, after all entities are created and configured.
---
--- We only restore entity.active - this is the master switch.
--- disabled_by_script is just a status indicator (side effect of active=false).
--- Circuit-driven disabling is dynamic and will be re-evaluated automatically.
---
--- @param entities_to_create table: List of entity data objects
--- @param entity_map table: Map of entity_id to LuaEntity
--- @param frozen_states table: Map of original_entity_id to original active state (boolean)
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
        
        -- Skip if no entity
        if not entity or not entity.valid then
            goto continue
        end
        
        -- NO TYPE FILTER. This loop restores the CAPTURED state, so it must cover every entity that
        -- anything upstream may have disabled — and three separate passes disable on different sets:
        -- entity_creation (all but beacon/radar/item-request-proxy), the pre-validation re-pause in
        -- import-completion (ACTIVATABLE_ENTITY_TYPES), and the source lock. Any filter here is a set
        -- that must stay in sync with all three, and both times we tried one it silently drifted:
        -- filtering by ACTIVATABLE left infinity-pipe x2 and spider-vehicle x2 frozen forever
        -- (measured 2026-07-28), and excluding beacon/radar/proxy instead left a beacon disabled by
        -- the re-pause pass with nothing to wake it (measured the same day, on the fix for the
        -- first). Restoring everything is the only version that cannot drift; an entity already in
        -- its captured state costs one guarded read.
        
        -- Look up the ORIGINAL active state from frozen_states.
        -- The entity_id in entity_data is the ORIGINAL unit_number from export.
        -- CRITICAL (cross-instance transfer): frozen_states is built on the SOURCE keyed by
        -- numeric unit_number, then transmitted as JSON. JSON object keys are strings, so a
        -- numeric key (12917) comes back as "12917"; a numeric lookup then MISSES and every
        -- entity wrongly defaults to active below — silently flipping inactive entities to
        -- active on the destination. Fall back to the string key. (Same-instance/clone paths
        -- keep numeric keys and hit the first lookup; stable-id entity_ids are already strings,
        -- so tostring is a no-op there.) Verified via a helpers.table_to_json round-trip on 2.0.76.
        local was_active = frozen_states[entity_data.entity_id]
        if was_active == nil and entity_data.entity_id ~= nil then
            was_active = frozen_states[tostring(entity_data.entity_id)]
        end

        -- If still not found, default to active (most entities are active)
        if was_active == nil then
            was_active = true
        end
        
        -- Reading .active is now GUARDED. The guard was removed when this loop was filtered to
        -- ACTIVATABLE_ENTITY_TYPES, where .active is guaranteed to exist; the loop now covers every
        -- type the import freezes and the read throws on some of them. Only the active read/write is
        -- wrapped — the held-item restore below must stay unguarded so a seating failure still
        -- surfaces. Cost is measured, not assumed: a pcall-per-entity pass over 542 entities is
        -- 0.174 ms versus 0.088 ms direct (helpers.create_profiler, 20 reps), against a
        -- full-surface find_entities_filtered at 0.93 ms.
        local read_ok, is_active = pcall(function() return entity.active end)
        if not read_ok or is_active == nil then
            skipped_count = skipped_count + 1
            goto continue
        end

        if was_active then
            -- Entity was active before export - re-enable it
            if not is_active then
                local wake_ok, wake_err = pcall(function() entity.disabled_by_script = false end)
                if wake_ok then
                    activated_count = activated_count + 1
                else
                    log(string.format("[Import] activate failed for '%s': %s",
                        tostring(entity.name), tostring(wake_err)))
                end
            end

            -- MINING PROGRESS is QUEUED here, not written. LuaControl.mining_progress: "For mining
            -- drills the number is with the range [0, mining_target.prototype.mineable_properties
            -- .mining_time]" — the value is DEFINED RELATIVE TO mining_target, mining_target is
            -- read-only, and it is nil until the drill's first update (update_connections does not
            -- bind it — measured 2026-07-29). So any write before that update lands (reads back) but
            -- is unanchored, and the cycle-start on first update replaces it: three same-execution
            -- restore points all "landed and lost" this way, while every write to a drill whose
            -- target was already bound stuck permanently. The queue is serviced by
            -- AsyncProcessor.process_tick and writes once mining_target exists.
            local sd = entity_data.specific_data
            if sd and sd.mining_progress and entity.type == "mining-drill" then
                ActiveStateRestoration.queue_mining_progress(entity, sd)
            end

            -- Idempotent held top-up (covers paths that reach restore() without the pre-gate
            -- pass; a hand already seated by restore_held_items_only is a no-op here).
            local restored, failed = restore_inserter_held(entity, entity_data)
            held_items_restored = held_items_restored + restored
            held_items_failed = held_items_failed + failed
        else
            -- Entity was inactive before export - keep it inactive. Held items are STILL
            -- restored for inactive inserters — seating needs no activation (set_stack is
            -- activation-independent; the old
            -- activate->set_stack->deactivate ritual here was refuted cargo and was removed).
            -- Without this, the frozen_states fix above would convert a state-only bug into a
            -- held-item LOSS for inactive inserters.
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
        
        ::continue::
    end
    
    log(string.format("[Import] Active state restoration complete: %d activated, %d kept inactive, %d skipped, held items: %d restored / %d failed",
        activated_count, kept_inactive_count, skipped_count, held_items_restored, held_items_failed))    
    
    if activated_count > 0 then
        game.print(string.format("[Import] Activated %d entities (restored to original state)", activated_count), {0, 1, 0})
    end
end

return ActiveStateRestoration
