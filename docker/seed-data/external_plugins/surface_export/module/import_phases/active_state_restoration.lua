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
--- CRITICAL: held_stack.set_stack() silently fails on a SETTLED-deactivated inserter,
--- so the caller MUST ensure entity.active == true before calling this.
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
    -- set_stack REPLACES the hand, so this tops up a PARTIALLY-filled hand too (the busy-loss case: the
    -- deserializer under-fills a deactivated/bulk inserter, leaving a non-empty-but-short hand). Caller MUST
    -- have set entity.active=true (set_stack under-fills a deactivated bulk inserter). The bool lies, so we
    -- read back and return the genuine shortfall (now a VISIBLE loss, not silent).
    local ok, err = pcall(function() entity.held_stack.set_stack(sd.held_item) end)
    if not ok then
        log(string.format("[Import] Failed to restore held item '%s' x%d for inserter: %s",
            sd.held_item.name or "?", want, tostring(err)))
    end
    local got = entity.held_stack.valid_for_read and entity.held_stack.count or 0
    if got < have then got = have end                          -- never report worse than before the call
    return got, math.max(0, want - got)
end

--- Restore inserter held items WITHOUT activating machines (pre-validation pass).
--- Held items are the only item category not present at the pre-activation validation gate
--- (set_stack fails on a settled-deactivated inserter, so they are normally restored only in the
--- post-activation restore() above). Restoring them here lets the STRICT transfer gate count them
--- while every machine stays deactivated — removing the "held phantom" (a few hundred items) from
--- the gate without opening a craft window (Pitfall #15: machines must stay inactive through
--- validation so they cannot consume/produce items between activation and counting).
--- Only inserters are briefly toggled active (within one synchronous pass, so they cannot swing);
--- each is returned to its prior (deactivated) state. Idempotent with restore(): its
--- `not valid_for_read` guard makes the later held-restore a no-op for hands filled here.
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
            -- Trigger on EMPTY *or* PARTIALLY-filled hands (have < captured), not only empty. The busy held-item
            -- loss is the deserializer leaving a hand partially filled (set_stack under-fills a deactivated bulk
            -- inserter) — the old `not valid_for_read` (empty-only) guard skipped those, so they were never
            -- topped up and vanished silently. Verified: src-held 80 -> dest-held 33 == gate loss 47.
            local want = entity_data.specific_data.held_item.count or 1
            local have = entity.held_stack.valid_for_read and entity.held_stack.count or 0
            if have < want then
                local was_active = entity.active
                entity.active = true  -- bulk-inserter capacity only applies when active; set_stack under-fills otherwise
                local got, short = restore_inserter_held(entity, entity_data)
                entity.active = was_active  -- restore prior (deactivated) state: machines-off invariant (Pitfall #15)
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
        
        -- Only process entity types that can be activated/deactivated
        if not ACTIVATABLE_ENTITY_TYPES[entity.type] then
            goto continue
        end
        
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
        
        -- Restore the original active state
        -- Note: pcall removed for performance - we filter by ACTIVATABLE_ENTITY_TYPES
        -- so entity.active is guaranteed to exist. If a modded entity causes issues,
        -- add error handling back or exclude that entity type.
        if was_active then
            -- Entity was active before export - re-enable it
            if not entity.active then
                entity.active = true
                activated_count = activated_count + 1
            end

            -- Retry inserter held_stack restoration AFTER reactivation
            -- (set_stack silently fails on a deactivated inserter; entity is active here).
            local restored, failed = restore_inserter_held(entity, entity_data)
            held_items_restored = held_items_restored + restored
            held_items_failed = held_items_failed + failed
        else
            -- Entity was inactive before export - keep it inactive.
            -- Held items must STILL be restored, but set_stack fails on a deactivated
            -- inserter, so temporarily activate, restore, then re-deactivate. Verified on
            -- 2.0.76: activate->set_stack->deactivate within one tick preserves the held
            -- stack durably (no inserter logic runs mid-script), and it survives settled
            -- deactivation. Without this, the frozen_states fix above would convert a
            -- state-only bug into a held-item LOSS for inactive inserters.
            if entity.type == "inserter"
               and entity_data.specific_data
               and entity_data.specific_data.held_item
               and entity.held_stack
               and not entity.held_stack.valid_for_read then
                entity.active = true
                local restored, failed = restore_inserter_held(entity, entity_data)
                held_items_restored = held_items_restored + restored
                held_items_failed = held_items_failed + failed
            end

            if entity.active then
                entity.active = false
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
