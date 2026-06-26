local GameUtils = require("modules/surface_export/utils/game-utils")
local VersionCompat = require("modules/surface_export/utils/version-compat")

local BeltRestoration = {}

local QUALITY_NORMAL = GameUtils.QUALITY_NORMAL

--- Restore all belt items synchronously in a single tick.
--- CRITICAL: Belts are always active and cannot be deactivated, so items must be restored all at once.
---
--- Factorio 2.0.76 LuaTransportLine API — VERIFIED EMPIRICALLY on the pinned engine via a controlled
--- custom-surface experiment (the signature itself is routed through version-compat.lua; do NOT trust
--- the "latest" lua-api docs — they reorder the params. Source of truth: lua-api.factorio.com/2.0.76/):
---     insert_at(position, items, belt_stack_size?) -> bool
---     insert_at_back(items, belt_stack_size?)      -> bool
--- `belt_stack_size` is the per-slot cap (turbo belts max 4); it CAPS how many of `items` land at the
--- position. Passing item.count works because a serialized slot holds <= 4. Two facts make the naive
--- approach lossy and drove this design:
---   1. insert_at returns TRUE even when it places FEWER than requested (a dense/occupied slot). The
---      bool is NOT a placement count — trusting it silently drops the unplaced remainder.
---   2. A connected run of belts is ONE segment but each belt exposes its OWN LuaTransportLine object
---      (line_equals is false across them), so a PER-LINE "did it all fit?" check under-counts and
---      spills DUPLICATES. Reconciliation must be GLOBAL.
---
--- Approach — a bank reconciliation (debit == credit), never trusting the insert bool:
---   Phase A: place every serialized slot at its recorded position; tally EXPECTED per (name,quality)
---            and remember each restored line (preserving multiplicity).
---   Phase B: PHYSICALLY measure what actually landed (get_contents over the SAME line set, so any
---            source-side shared-line double-count cancels), and settle the NET shortfall per item to
---            the ground (item-on-ground — still on the platform, counted, merely relocated). This can
---            only relocate; it can never lose or duplicate.
--- All API errors are LOGGED, never swallowed.
---
--- @param entities_to_create table: List of entity data objects
--- @param entity_map table: Map of entity_id to LuaEntity
function BeltRestoration.restore(entities_to_create, entity_map)
    log("[Import] Restoring belt items (2.0.76 insert_at(position, items, belt_stack_size) + global reconcile)...")

    local belt_count = 0
    local expected = {}        -- quality_key -> { name, quality, count } : the debit (from serialized data)
    local restored_lines = {}  -- one entry per restored line_data (multiplicity preserved for measurement)
    local anchor = nil         -- a valid belt entity to anchor ground spills

    -- ---- Phase A: place every slot at its recorded position; tally the debit. --------------------
    for _, entity_data in ipairs(entities_to_create) do
        local entity = entity_map[entity_data.entity_id]

        if not entity or not entity.valid then goto continue end
        if not entity_data.specific_data or not entity_data.specific_data.items then goto continue end
        if not entity.get_transport_line then goto continue end

        belt_count = belt_count + 1
        anchor = anchor or entity

        for _, line_data in ipairs(entity_data.specific_data.items) do
            local line = entity.get_transport_line(line_data.line)
            if line and line.valid then
                restored_lines[#restored_lines + 1] = line

                for _, item in ipairs(line_data.items) do
                    local quality = item.quality or QUALITY_NORMAL
                    local key = GameUtils.make_quality_key(item.name, quality)
                    local exp = expected[key]
                    if not exp then
                        exp = { name = item.name, quality = quality, count = 0 }
                        expected[key] = exp
                    end
                    exp.count = exp.count + item.count

                    local stack = { name = item.name, count = item.count, quality = quality }

                    -- Place at the exact source position (belt_stack_size = item.count, the slot's cap).
                    -- We DO NOT trust the bool for accounting — Phase B measures physical reality. The
                    -- pcall+log stays here (richest context) per the never-swallow-errors rule.
                    local placed = false
                    if item.position then
                        local ok, res = pcall(function()
                            return VersionCompat.belt_insert_at(line, item.position, stack, item.count)
                        end)
                        if not ok then
                            log(string.format("[Belt Restore] insert_at ERROR on %s line %d (pos=%s): %s",
                                entity.name, line_data.line, tostring(item.position), tostring(res)))
                        end
                        placed = ok and res == true
                    end

                    -- Positionless (or position rejected): best-effort append at the back. Still not
                    -- trusted for accounting — Phase B is authoritative.
                    if not placed then
                        local ok, res = pcall(function()
                            return VersionCompat.belt_insert_at_back(line, stack, item.count)
                        end)
                        if not ok then
                            log(string.format("[Belt Restore] insert_at_back ERROR on %s line %d: %s",
                                entity.name, line_data.line, tostring(res)))
                        end
                    end
                end
            end
        end

        ::continue::
    end

    -- ---- Phase B: measure the credit, settle the net shortfall to ground. ------------------------
    -- Measure over the SAME (entity, line) set Phase A summed `expected` over — read each restored
    -- line once. Belts are frozen for this whole synchronous pass (no tick elapses), so nothing moves
    -- between placement and measurement; get_contents is exactly what we placed.
    local actual = {}
    for _, line in ipairs(restored_lines) do
        if line.valid then
            local ok, contents = pcall(function() return line.get_contents() end)
            if not ok then
                log(string.format("[Belt Restore] get_contents ERROR during reconcile: %s", tostring(contents)))
            elseif contents then
                for _, c in ipairs(contents) do
                    local key = GameUtils.make_quality_key(c.name, c.quality or QUALITY_NORMAL)
                    actual[key] = (actual[key] or 0) + c.count
                end
            end
        end
    end

    local placed_count = 0
    local relocated_count = 0
    local failed_count = 0
    for key, exp in pairs(expected) do
        local got = actual[key] or 0
        if got > exp.count then got = exp.count end  -- never credit more than the debit
        placed_count = placed_count + got

        local short = exp.count - (actual[key] or 0)
        if short > 0 then
            -- Genuine net shortfall: these items did not fit on the belts. Relocate to the ground so
            -- the platform total is conserved (debit == credit). Spilled items become item-on-ground,
            -- which the surface counter includes — no item loss, just belt -> floor.
            local stack = { name = exp.name, count = short, quality = exp.quality }
            local ok, spilled = pcall(function()
                return anchor.surface.spill_item_stack({
                    position = anchor.position,
                    stack = stack,
                    enable_looted = false,
                    allow_belts = false,
                })
            end)
            if ok and spilled and #spilled > 0 then
                relocated_count = relocated_count + short
            else
                failed_count = failed_count + short
                log(string.format("[Belt Restore] LOST %d x %s (q=%s) — net shortfall AND ground spill failed (err=%s)",
                    short, exp.name, tostring(exp.quality), tostring(spilled)))
            end
        end
    end

    log(string.format("[Import] Belt restoration complete. Processed %d belts, %d items on belts (%d relocated to ground), %d lost.",
        belt_count, placed_count, relocated_count, failed_count))

    if relocated_count > 0 then
        log(string.format("[Belt Restore] %d belt items relocated to ground (net shortfall on restore) — NO item loss",
            relocated_count))
    end
    if failed_count > 0 then
        game.print(string.format("[Import Warning] LOST %d belt items (net shortfall AND ground spill failed)", failed_count), {1, 0.5, 0})
    end

    return {
        belts_processed = belt_count,
        items_restored = placed_count + relocated_count,
        items_relocated = relocated_count,
        items_failed = failed_count,
    }
end

return BeltRestoration
