-- Surface Locking Utilities
-- Handles locking surfaces during transfer to prevent modifications

local GameUtils = require("modules/surface_export/utils/game-utils")
local PlatformSchedule = require("modules/surface_export/utils/platform-schedule")

local SurfaceLock = {}

local ACTIVATABLE_ENTITY_TYPES = GameUtils.ACTIVATABLE_ENTITY_TYPES
local DEFAULT_TRANSFER_LOCK_TTL_TICKS = 36000 -- 10 minutes at 60 UPS
-- R6: the worst-case-TOTAL-transfer floor, DERIVED from named components (NOT a duplicate of DEFAULT) so the
-- selftest's `DEFAULT >= MIN` is a real check — lowering DEFAULT below the real worst case now fails, and each
-- component is independently visible/tunable.
local VALIDATION_TIMEOUT_TICKS     = 7200  -- 120s validation timeout (helpers.ts VALIDATION_TIMEOUT_MS) at 60 UPS
local WORST_CASE_RCON_TICKS        = 3000  -- ~50s: a 235KB platform @ ~6KB/s chunked RCON, rounded up
local WORST_CASE_SCAN_IMPORT_TICKS = 6000  -- ~100s: async export scan + destination import (~100 entities/tick each)
local WORST_CASE_MARGIN_TICKS      = 3000  -- ~50s controller queue / round-trip / jitter slack
local MIN_WORST_CASE_TRANSFER_TTL_TICKS =
    VALIDATION_TIMEOUT_TICKS + WORST_CASE_RCON_TICKS + WORST_CASE_SCAN_IMPORT_TICKS + WORST_CASE_MARGIN_TICKS -- 19200 (~5.3 min); DEFAULT 36000 clears it ~1.9×
SurfaceLock.DEFAULT_TRANSFER_LOCK_TTL_TICKS = DEFAULT_TRANSFER_LOCK_TTL_TICKS
SurfaceLock.MIN_WORST_CASE_TRANSFER_TTL_TICKS = MIN_WORST_CASE_TRANSFER_TTL_TICKS
local EXPIRABLE_LOCK_KINDS = { transfer = true, export = true }

--- Freeze all entities on a surface (synchronous - very fast)
--- CRITICAL: This captures the ORIGINAL active state BEFORE freezing.
--- The frozen_states table is included in export data so import can restore
--- entities to their exact pre-export state.
---
--- We only record entity.active - this is the master switch.
--- disabled_by_script is just a status indicator (side effect of active=false).
--- Circuit-driven disabling is dynamic and will be re-evaluated on import.
---
--- @param surface LuaSurface: Surface to freeze
--- @return table, number: Map of entity_id -> original active state, frozen count
local function freeze_entities(surface)
    local original_states = {}
    local frozen_count = 0
    
    local entities = surface.find_entities_filtered({})
    for _, entity in pairs(entities) do
        if entity.valid and ACTIVATABLE_ENTITY_TYPES[entity.type] then
            -- Use unit_number if available, otherwise generate stable ID
            -- MUST match the entity_id format used in EntityScanner.serialize_entity()
            local unit_id = entity.unit_number or GameUtils.make_stable_id(entity)
            
            -- Check if entity has an active property
            local ok, has_active = pcall(function() return entity.active ~= nil end)
            if not ok then
                -- Entity is in ACTIVATABLE_ENTITY_TYPES, so reading .active should succeed.
                log(string.format("[SurfaceLock] freeze: reading entity.active failed for '%s': %s",
                    tostring(entity.name), tostring(has_active)))
            elseif has_active then
                -- CRITICAL: Capture the active state BEFORE we freeze
                local was_active = entity.active
                original_states[unit_id] = was_active
                
                -- Freeze the entity
                if was_active then
                    entity.active = false
                    frozen_count = frozen_count + 1
                end
            end
        end
    end
    
    log(string.format("[SurfaceLock] Froze %d entities, captured %d original states", 
        frozen_count, frozen_count))
    return original_states, frozen_count
end

--- Unfreeze entities by restoring original active states
--- @param surface LuaSurface: Surface to unfreeze
--- @param original_states table: Map of entity_id -> original active state (boolean)
--- @return number: Count of entities restored
local function unfreeze_entities(surface, original_states)
    if not original_states or not next(original_states) then
        return 0
    end
    
    local restored_count = 0
    local entities = surface.find_entities_filtered({})
    
    for _, entity in pairs(entities) do
        if entity.valid and ACTIVATABLE_ENTITY_TYPES[entity.type] then
            local unit_id = entity.unit_number or GameUtils.make_stable_id(entity)
            local was_active = original_states[unit_id]
            
            -- Restore original active state
            if was_active ~= nil then
                local ok, err = pcall(function() entity.active = was_active end)
                if not ok then
                    log(string.format("[SurfaceLock] unfreeze: restoring entity.active failed for '%s': %s",
                        tostring(entity.name), tostring(err)))
                elseif was_active then
                    restored_count = restored_count + 1
                end
            end
        end
    end
    
    log(string.format("[SurfaceLock] Restored %d entities to active state", restored_count))
    return restored_count
end

--- Activate all freezable entities on a surface
--- Used after successful validation to bring an imported platform to life
--- Sets entity.active = true for all freezable entity types
--- @param surface LuaSurface: Surface to activate
--- @return number: Count of entities activated
function SurfaceLock.activate_all(surface)
    local activated_count = 0
    
    local entities = surface.find_entities_filtered({})
    for _, entity in pairs(entities) do
        if entity.valid and ACTIVATABLE_ENTITY_TYPES[entity.type] then
            GameUtils.pcall_warn("[SurfaceLock] activate_all: activating entity '" .. tostring(entity.name) .. "'", function()
                if not entity.active then
                    entity.active = true
                    activated_count = activated_count + 1
                end
            end)
        end
    end
    
    log(string.format("[SurfaceLock] Activated %d entities", activated_count))
    return activated_count
end

--- Recover a cargo pod's loaded cargo (its cargo_unit inventory) so NOTHING is lost when the pod is destroyed:
--- insert what fits into the hub, and SPILL any remainder onto the surface. Item-on-ground is scanned/exported
--- with the platform, so even a FULL hub (or a missing hub) is still zero-loss. Nil-safe. Returns the count
--- preserved either in the hub or on the platform surface.
--- @param pod LuaEntity: the cargo pod
--- @param hub LuaEntity|nil: the platform hub (may be nil/invalid)
--- @param surface LuaSurface: the platform surface (spill target)
--- @return number: items preserved in the hub or spilled onto the platform
local function recover_pod_cargo_to_hub_and_spill(pod, hub, surface)
    local inventory = pod.get_inventory(defines.inventory.cargo_unit)
    if not inventory then return 0 end
    local hub_inventory = (hub and hub.valid) and hub.get_inventory(defines.inventory.hub_main) or nil
    local preserved = 0
    for i = 1, #inventory do
        local stack = inventory[i]
        if stack.valid_for_read then
            local stack_name = stack.name
            local stack_count = stack.count
            local stack_quality = stack.quality and stack.quality.name or nil
            local inserted = hub_inventory and hub_inventory.insert(stack) or 0
            preserved = preserved + inserted
            local remainder = stack_count - inserted
            if inserted > 0 then
                if remainder > 0 then
                    stack.count = remainder
                else
                    stack.clear()
                end
            end
            if remainder > 0 then
                local spill_ok, spill_err = pcall(function()
                    surface.spill_item_stack({
                        position = pod.position,
                        stack = { name = stack_name, count = remainder, quality = stack_quality },
                    })
                end)
                if spill_ok then
                    preserved = preserved + remainder
                    stack.clear()
                else
                    log(string.format("[SurfaceLock] cargo recovery spill failed for %d %s: %s",
                        remainder, tostring(stack_name), tostring(spill_err)))
                end
            end
        end
    end
    return preserved
end

--- Complete all in-flight cargo pod transfers immediately
--- Descending/parking pods: recover cargo to the platform, then remove the pod.
--- Ascending pods: Force finish (items are already "sent")
--- @param surface LuaSurface: The platform surface
--- @param hub LuaEntity: The space platform hub
--- @return number, number, number: descending_count, ascending_count, items_recovered
local function complete_cargo_pods(surface, hub)
    local pods = surface.find_entities_filtered({name = "cargo-pod"})
    local descending_count = 0
    local ascending_count = 0
    local items_recovered = 0
    
    for _, pod in ipairs(pods) do
        if pod.valid then
            local state = pod.cargo_pod_state
            
            if state == "descending" or state == "parking" then
                -- Incoming cargo: recover into the hub, spilling overflow onto the platform, then remove the pod.
                -- This avoids relying on force_finish_descending's overflow behavior and keeps the held surface pod-free.
                items_recovered = items_recovered + recover_pod_cargo_to_hub_and_spill(pod, hub, surface)
                pod.destroy()
                descending_count = descending_count + 1

            elseif state == "ascending" or state == "surface_transition" then
                -- Outgoing cargo: just force complete (items are already "sent")
                pod.force_finish_ascending()
                ascending_count = ascending_count + 1
                
            elseif state == "awaiting_launch" then
                -- Pod loaded but not yet launched — its cargo_unit may hold items, and a bare destroy() would
                -- DELETE them. Recover them (into the hub; overflow spilled to the surface — both export with the
                -- platform) BEFORE destroy → ZERO loss even when the hub is full. (Engineering FAQ / re-audit P2.)
                items_recovered = items_recovered + recover_pod_cargo_to_hub_and_spill(pod, hub, surface)
                pod.destroy()
            end
        end
    end
    
    if descending_count > 0 or ascending_count > 0 or items_recovered > 0 then
        log(string.format("[SurfaceLock] Completed %d descending pods (recovered %d items), %d ascending pods",
            descending_count, items_recovered, ascending_count))
    end
    
    return descending_count, ascending_count, items_recovered
end
SurfaceLock.complete_cargo_pods = complete_cargo_pods

--- Re-key storage.locked_platforms from any legacy NAME (string) keys to the unique platform.index, using the
--- platform_index stored inside each lock_data. Idempotent + cheap: returns immediately when every key is
--- already numeric (the steady state), so it is safe to call on every lock. Belt-and-suspenders against a
--- code update that did NOT fire on_configuration_changed (e.g. a save-patch code swap) leaving a name-keyed
--- lock un-migrated — without this, is_locked(index) would false-negative and the still-frozen platform would
--- look unlocked. (Cannot run in on_load — Factorio forbids writing storage there.)
--- @return number moved, number dropped
function SurfaceLock.ensure_index_keyed()
    local locks = storage.locked_platforms
    if type(locks) ~= "table" then return 0, 0 end
    local has_string_key = false
    for k, _ in pairs(locks) do
        if type(k) == "string" then has_string_key = true; break end
    end
    if not has_string_key then return 0, 0 end  -- already index-keyed (steady state) — no rebuild

    local rekeyed, moved, dropped = {}, 0, 0
    for key, lock_data in pairs(locks) do
        if type(key) == "number" then
            rekeyed[key] = lock_data
        elseif type(lock_data) == "table" and type(lock_data.platform_index) == "number" then
            rekeyed[lock_data.platform_index] = lock_data
            moved = moved + 1
        else
            dropped = dropped + 1
        end
    end
    storage.locked_platforms = rekeyed
    log(string.format("[SurfaceLock] Migrated lock registry to index keys: %d re-keyed, %d dropped (no index)", moved, dropped))
    return moved, dropped
end

--- Pure: is an incoming transfer lock the SAME transfer as the existing transfer lock at this index (so its
--- pre-lock→export-queue backfill may proceed), or a DIFFERENT/second transfer (which must be rejected so it
--- cannot OVERWRITE the first transfer's correlation token)? Same iff the existing token is unset — the initial
--- transfer-trigger → export-pipeline handoff, where only export-pipeline carries the job_id — or equals the
--- incoming one. This is the UNIVERSAL guard: it protects EVERY entry path (the in-game trigger AND the web/ctl
--- export_platform route), because all of them lock through lock_platform. Pure → unit-testable.
--- @param existing_job_id string|nil  the existing lock's transfer_job_id
--- @param opts_job_id string|nil  the incoming lock_opts.job_id
--- @return boolean same
function SurfaceLock.is_same_transfer_upgrade(existing_job_id, opts_job_id)
    return existing_job_id == nil or existing_job_id == opts_job_id
end

--- Lock a platform surface for export/transfer
--- Completes cargo pod transfers, freezes entities, hides surface
--- @param platform LuaSpacePlatform: The platform to lock
--- @param force LuaForce: The force that owns the platform
--- @param lock_opts table|nil: Optional {job_id, expires_tick} for transfer locks only
--- @return boolean, string|nil: success, error_message
function SurfaceLock.lock_platform(platform, force, lock_opts)
    if not platform or not platform.valid then
        return false, "Platform not valid"
    end

    local surface = platform.surface
    if not surface or not surface.valid then
        return false, "Platform surface not valid"
    end

    -- Initialize storage
    if not storage.locked_platforms then
        storage.locked_platforms = {}
    end
    -- Migrate any legacy name-keyed entries to index keys before we read/write the registry (cheap no-op
    -- once index-keyed). Covers a deploy that didn't fire on_configuration_changed — see ensure_index_keyed.
    SurfaceLock.ensure_index_keyed()

    -- Check if already locked. Keyed by the UNIQUE platform.index (not the mutable, non-unique name) so
    -- two same-named platforms can't collide in the registry (#81). Name is kept inside lock_data for display.
    local existing_lock = storage.locked_platforms[platform.index]
    if existing_lock then
        -- Same-transfer re-lock (backfill): identity is surface.index (stable across a rename), NOT the mutable
        -- platform.name. The registry is already keyed by the unique platform.index; surface.index additionally
        -- rejects an index REUSED by a different platform (its surface differs) → that falls through to the
        -- "different transfer lock" refusal below. A rename keeps surface.index, so a renamed source re-locks fine.
        if lock_opts and lock_opts.kind == "transfer" and existing_lock.kind == "transfer"
            and existing_lock.surface_index == surface.index then
            -- Only the SAME transfer's pre-lock→export-queue handoff may upgrade this lock: its token is either
            -- not stamped yet (transfer-trigger locked first, no job_id) or equal. A DIFFERENT token — or, for a
            -- token-less caller, ANY existing token — means a SECOND transfer of an in-flight platform. REJECT it,
            -- else it OVERWRITES the first transfer's correlation token → the first transfer's source delete then
            -- refuses (job_id mismatch) AFTER its destination committed = a live-source + committed-dest DUP.
            if not SurfaceLock.is_same_transfer_upgrade(existing_lock.transfer_job_id, lock_opts.job_id) then
                return false, "Platform already locked by a different in-flight transfer"
            end
            existing_lock.transfer_job_id = lock_opts.job_id or existing_lock.transfer_job_id
            existing_lock.expires_tick = lock_opts.expires_tick or existing_lock.expires_tick
            return true, nil -- same transfer lock upgraded
        end
        if lock_opts and lock_opts.kind == "transfer" and existing_lock.kind == "transfer" then
            return false, "Platform already locked by a different transfer lock"
        end
        if lock_opts and lock_opts.kind == "transfer" and existing_lock.kind ~= "transfer" then
            return false, "Platform already locked by a non-transfer lock"
        end
        return false, "Platform already locked"
    end

    -- Store original state
    local original_hidden = force.get_surface_hidden(surface)
    local original_schedule, schedule_err = PlatformSchedule.capture(platform, platform.hub)
    if not original_schedule then
        return false, "Failed to capture original platform schedule: " .. tostring(schedule_err)
    end

    -- Lock the surface (hide from players)
    force.set_surface_hidden(surface, true)

    -- Complete all in-flight cargo pod transfers immediately
    local hub = platform.hub
    local descending, ascending, items = complete_cargo_pods(surface, hub)
    
    if descending > 0 or ascending > 0 then
        game.print(string.format("[Lock] Completed %d incoming (%d items) and %d outgoing cargo pods", 
            descending, items, ascending), {0.5, 1, 0.5})
    end

    -- Freeze all entities (synchronous - very fast)
    local frozen_states, frozen_count = freeze_entities(surface)

    -- Store lock data, keyed by the unique platform.index (name lives inside for display + cross-check).
    storage.locked_platforms[platform.index] = {
        platform_name = platform.name,
        platform_index = platform.index,
        surface_index = surface.index,
        force_name = force.name,
        original_hidden = original_hidden,
        original_schedule = original_schedule,
        locked_tick = game.tick,
        kind = lock_opts and lock_opts.kind or nil,
        transfer_job_id = lock_opts and lock_opts.job_id or nil,
        expires_tick = lock_opts and lock_opts.expires_tick or nil,
        frozen_states = frozen_states,
        frozen_count = frozen_count,
    }

    log(string.format("[SurfaceLock] Locked platform '%s' (index %d), froze %d entities", 
        platform.name, platform.index, frozen_count))

    return true, nil
end

--- Unlock a platform surface (restore original state and unfreeze entities)
--- @param platform_index number: Unique index of the platform to unlock (the registry key)
--- @return boolean, string|nil: success, error_message
--- @param platform_index number
--- @param expected_name string|nil When provided, a NAME TRIPWIRE: refuse if the lock at this index is for a
---        DIFFERENTLY-named platform. The surface.index tripwire below only validates lock-data-vs-current
---        platform; it does NOT catch a per-force index REUSED by an unrelated transfer's (valid) lock, so a
---        stale caller must also assert the name, mirroring the delete path.
function SurfaceLock.unlock_platform(platform_index, expected_name)
    if not storage.locked_platforms then
        return false, "No locked platforms"
    end

    local lock_data = storage.locked_platforms[platform_index]
    if not lock_data then
        return false, "Platform not locked: index " .. tostring(platform_index)
    end
    local platform_name = lock_data.platform_name  -- display only
    if expected_name ~= nil and platform_name ~= expected_name then -- lint-lua:allow compares STORED snapshots (lock_data name vs caller expectation), not the live platform.name — not rename-vulnerable; surface.index is the primary identity at the tripwire below. Collision-residual follow-up: pass expected_surface_index.
        return false, string.format("Unlock refused: index %s is locked for a DIFFERENT platform (expected '%s', locked '%s')",
            tostring(platform_index), tostring(expected_name), tostring(platform_name))
    end

    -- Find the platform
    local force = game.forces[lock_data.force_name]
    if not force then
        storage.locked_platforms[platform_index] = nil
        return false, "Force not found: " .. tostring(lock_data.force_name)
    end

    local platform = force.platforms[lock_data.platform_index]
    if not platform or not platform.valid then
        storage.locked_platforms[platform_index] = nil
        return false, "Platform no longer exists"
    end

    local surface = platform.surface
    -- IDENTITY TRIPWIRE (symmetric with the delete path's name cross-check): only restore onto this platform
    -- if it is the SAME one we locked. surface.index is the stable identity — a rename keeps it, but a
    -- per-force platform INDEX reused after the source was deleted gets a NEW surface. If a different platform
    -- now holds this index, do NOT restore (it would clobber an unrelated platform's frozen-state + schedule);
    -- just drop the stale lock entry.
    if not (surface and surface.valid and surface.index == lock_data.surface_index) then
        storage.locked_platforms[platform_index] = nil
        log(string.format("[SurfaceLock] unlock: index %s now holds a different surface (locked %s, found %s) — dropping stale lock WITHOUT restoring",
            tostring(platform_index), tostring(lock_data.surface_index), tostring(surface and surface.index)))
        return false, "Platform index reused since lock — stale lock dropped (not restored)"
    end

    -- Restore entity active states, original visibility, and the full original schedule.
    local restored = unfreeze_entities(surface, lock_data.frozen_states)
    force.set_surface_hidden(surface, lock_data.original_hidden)
    if lock_data.original_schedule then
        local schedule_restore_ok, schedule_restore_err = PlatformSchedule.apply(platform, lock_data.original_schedule)
        if not schedule_restore_ok then
            storage.locked_platforms[platform_index] = nil
            return false, "Failed to restore original platform schedule: " .. tostring(schedule_restore_err)
        end
    end

    -- Remove lock data
    storage.locked_platforms[platform_index] = nil

    log(string.format("[SurfaceLock] Unlocked platform '%s' (index %s), restored %d entities",
        tostring(platform_name), tostring(platform_index), restored))
    game.print(string.format("[Lock] Platform '%s' unlocked and restored", tostring(platform_name)), {0.5, 1, 0.5})

    return true, nil
end

--- Check if a platform is locked
--- @param platform_index number: Unique index of the platform (registry key)
--- @return boolean: true if locked
function SurfaceLock.is_locked(platform_index)
    if not storage.locked_platforms then
        return false
    end
    return storage.locked_platforms[platform_index] ~= nil
end

--- Get lock data for a platform
--- @param platform_index number: Unique index of the platform (registry key)
--- @return table|nil: Lock data or nil if not locked
function SurfaceLock.get_lock_data(platform_index)
    if not storage.locked_platforms then
        return nil
    end
    return storage.locked_platforms[platform_index]
end

--- Pure identity check for the source-delete-for-transfer precondition (Pitfall #31 — identity = surface.index,
--- NEVER platform.name). Given the stored lock record (captured BEFORE any unlock, since unlock clears it) and
--- the CURRENT surface at that platform index, decide whether it is safe to delete the source:
---   (1) the source must still be locked-for-transfer  — lock present with kind=="transfer" (a source released
---       by the TTL/admin is LIVE again and must NOT be deleted), AND
---   (2) the current platform must be the SAME one we locked — surface.index matches the lock's stored
---       surface_index. surface.index is stable across a player rename, so a rename is correctly IGNORED; a
---       per-force index REUSED by a different platform has a different surface → rejected.
--- Pure (no storage/game access) so it is unit-testable with fake records — see transfer-lock-selftest.
--- @param lock table|nil  the lock record (storage.locked_platforms[index])
--- @param current_surface LuaSurface|nil  the surface of the platform now at that index
--- @param expected_job_id string|nil  the delete request's transfer id (== the lock's transfer_job_id) — a
---        NAME-FREE request-vs-lock correlation. When both sides are present they MUST match.
--- @return boolean ok, string|nil reason
function SurfaceLock.transfer_delete_identity_ok(lock, current_surface, expected_job_id)
    if not lock or lock.kind ~= "transfer" then
        return false, "source is not locked-for-transfer (released by TTL/admin, or never locked)"
    end
    -- Request-vs-lock correlation (NAME-FREE): a stale/duplicate/reused-index delete request for a DIFFERENT
    -- transfer will not match this lock's transfer_job_id, so the caller refuses WITHOUT touching the unrelated
    -- transfer's lock or platform. Nil-guarded: an old-save lock or a caller without a job id degrades to the
    -- surface.index check (no worse than before; real transfers always carry both).
    if expected_job_id and lock.transfer_job_id and lock.transfer_job_id ~= expected_job_id then
        return false, string.format("lock belongs to a different transfer (job_id '%s' != requested '%s')",
            tostring(lock.transfer_job_id), tostring(expected_job_id))
    end
    if not (current_surface and current_surface.valid and current_surface.index == lock.surface_index) then
        return false, "surface identity mismatch (index reused since lock?)"
    end
    return true, nil
end

--- Resolve a user-supplied platform NAME to the registry key (unique index). For ADMIN-RECOVERY commands
--- ONLY (the transfer spine always has the index) — e.g. unlocking an orphaned lock whose platform was
--- deleted. Scans the registry by stored display name and FAILS LOUD on ambiguity (≥2 locks share the
--- name) rather than silently picking one.
--- @param platform_name string
--- @return number|nil index, string|nil error
function SurfaceLock.find_lock_key_by_name(platform_name)
    if not storage.locked_platforms then
        return nil
    end
    local found, count = nil, 0
    for idx, lock_data in pairs(storage.locked_platforms) do
        if lock_data.platform_name == platform_name then -- lint-lua:allow sanctioned name→index resolver at the ADMIN tooling boundary (fails loud on ambiguity below) — the owner-approved exception to "identity = surface.index"
            found = idx
            count = count + 1
        end
    end
    if count > 1 then
        return nil, "ambiguous: " .. count .. " locked platforms named '" .. tostring(platform_name) .. "' — unlock by index"
    end
    return found, nil
end

--- Scan transfer locks for durable tick-based expiry. Only transfer locks are touched.
--- Manual/admin locks and old-save locks without enough timing data are skipped.
--- @return table summary
function SurfaceLock.scan_transfer_expiries()
    if not storage.locked_platforms then
        return { checked = 0, expired = 0, skipped = 0, failed = 0 }
    end

    local checked, expired, skipped, failed = 0, 0, 0, 0

    for platform_index, lock_data in pairs(storage.locked_platforms) do
        if type(lock_data) == "table" and EXPIRABLE_LOCK_KINDS[lock_data.kind] then
            checked = checked + 1
            local locked_tick = lock_data.locked_tick
            if not locked_tick then
                skipped = skipped + 1 -- skip old-save locks without enough timing data
            else
                local expires_tick = lock_data.expires_tick or (locked_tick + DEFAULT_TRANSFER_LOCK_TTL_TICKS)
                if game.tick >= expires_tick then
                    log(string.format("[SurfaceLock] Transfer lock expired: '%s' (index %s, locked_tick=%s, expires_tick=%s)",
                        tostring(lock_data.platform_name), tostring(platform_index), tostring(locked_tick), tostring(expires_tick)))
                    -- R4: SURFACE a failed auto-unlock (don't swallow its result). unlock_platform unfreezes +
                    -- un-hides BEFORE restoring the schedule and drops the lock even when the schedule restore
                    -- fails — so a failure can leave the source live+visible with a stale schedule and no lock.
                    -- Counting/logging it means the tick loop + selftest have a signal instead of a silent gap.
                    local ok, err = SurfaceLock.unlock_platform(platform_index, lock_data.platform_name)
                    if ok then
                        expired = expired + 1
                    else
                        failed = failed + 1
                        log(string.format("[SurfaceLock] Transfer-lock expiry UNLOCK FAILED for '%s' (index %s): %s",
                            tostring(lock_data.platform_name), tostring(platform_index), tostring(err)))
                    end
                end
            end
        end
    end

    return { checked = checked, expired = expired, skipped = skipped, failed = failed }
end

return SurfaceLock
