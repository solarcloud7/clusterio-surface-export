local GameUtils = require("modules/surface_export/utils/game-utils")
local VersionCompat = require("modules/surface_export/utils/version-compat")

local BeltRestoration = {}

local QUALITY_NORMAL = GameUtils.QUALITY_NORMAL

--- Restore all belt items synchronously in a single tick.
--- CRITICAL: Belts are always active and cannot be deactivated, so items must be restored all at once.
---
--- Factorio 2.0.76 LuaTransportLine API (signature routed through version-compat.lua; source of truth is
--- lua-api.factorio.com/2.0.76/, NOT the "latest" docs which reorder the params):
---     insert_at(position, items, belt_stack_size?) -> bool     (position FIRST; belt_stack_size caps the slot)
---
--- THE FIX (verified empirically, apples-to-apples, on the pinned engine):
--- Re-insert each captured slot at its EXACT position, but in ASCENDING POSITION ORDER. A controlled
--- single-loop experiment (custom surface, items packed by real belt movement, source-vs-dest physical
--- counts) showed:
---   * Inserting in the captured (UNSORTED) order lets an earlier insert occupy a slot a later item needs, so
---     insert_at PARTIAL-places and returns true anyway (the bool lies) → a few items silently dropped.
---   * Inserting SORTED BY POSITION (ascending) makes every item land at its exact position because each new
---     item goes ahead of all already-placed ones — no collisions. Result: 100% on-belt across single items
---     (belt_stack_size 1) and full stacks (4) on every ISOLATED topology (R0–R1e in tests/belt-lab/).
---
--- WHY THERE IS NO OVERFLOW ROUTING (proven dead-end — see tests/belt-lab/NOTEBOOK.md "DECISIVE A/B"):
--- A post-pass that re-routed `insert_at`-rejected items to connected lines was tried and REMOVED. It
--- DUPLICATED items (+108 gain on a real transfer, totalItemLoss=0). Root cause: belts are "windows" onto a
--- shared merged internal line, so a per-window `get_item_count()` delta cannot see placement that landed on a
--- sibling window. That under-count both (a) inflates the unplaced remainder → routing re-places items that
--- were already on the belt → duplication, and (b) makes the per-line "terminal_failed" tally over-report
--- massively (observed 507 "unplaceable" while the authoritative whole-surface gate showed only −8 truly
--- missing). You cannot reliably measure per-window placement on a merged segment, so routing has no sound
--- foundation. The residual −8 (iron-plate, output-edge item that max-compression can't reconstruct) is the
--- documented sub-0.1% belt floor and is well within the strict transfer gate. The GATE — a whole-surface
--- physical count — is the authoritative loss instrument here, NOT these per-line counters.
---
--- @param entities_to_create table: List of entity data objects
--- @param entity_map table: Map of entity_id to LuaEntity
function BeltRestoration.restore(entities_to_create, entity_map)
    log("[Import] Restoring belt items (2.0.76: sort slots by position, then insert_at — 100% on-belt)...")

    local belt_count = 0
    local placed_count = 0      -- items physically placed (per-line get_item_count delta — see caveat below)
    local expected_total = 0    -- total belt items the payload says should be on belts
    -- NOTE: per-line `placed`/`unplaced` OVER-report misses on merged segments (a sibling window absorbs the
    -- item invisibly). They are a rough diagnostic only — the transfer gate's whole-surface physical count is
    -- authoritative. We do NOT route, re-insert, or raise a user-facing alarm off these numbers (that path
    -- duplicated; see header + NOTEBOOK).
    local unplaced_diag = 0

    for _, entity_data in ipairs(entities_to_create) do
        local entity = entity_map[entity_data.entity_id]

        if not entity or not entity.valid then goto continue end
        if not entity_data.specific_data or not entity_data.specific_data.items then goto continue end
        if not entity.get_transport_line then goto continue end

        belt_count = belt_count + 1

        for _, line_data in ipairs(entity_data.specific_data.items) do
            local line = entity.get_transport_line(line_data.line)
            if line and line.valid then
                -- Collect this line's slots and the expected total, then SORT BY POSITION ASCENDING.
                -- Position order = collision-free placement (see header).
                local slots = {}
                local expected = 0
                for _, item in ipairs(line_data.items) do
                    slots[#slots + 1] = item
                    expected = expected + item.count
                end
                expected_total = expected_total + expected
                table.sort(slots, function(a, b) return (a.position or 0) < (b.position or 0) end)

                for _, item in ipairs(slots) do
                    local stack = {
                        name = item.name,
                        count = item.count,
                        quality = item.quality or QUALITY_NORMAL,
                    }
                    local before = line.get_item_count()
                    local ok, err = pcall(function()
                        if item.position then
                            return VersionCompat.belt_insert_at(line, item.position, stack, item.count)
                        else
                            return VersionCompat.belt_insert_at_back(line, stack, item.count)
                        end
                    end)
                    if not ok then
                        -- A genuine insert exception (signature/API misuse) — reliable, log it loud.
                        log(string.format("[Belt Restore] insert ERROR on %s line %d: %s",
                            entity.name, line_data.line, tostring(err)))
                    end
                    local placed = line.get_item_count() - before
                    placed_count = placed_count + placed
                    if placed < item.count then
                        unplaced_diag = unplaced_diag + (item.count - placed)
                    end
                end
            end
        end

        ::continue::
    end

    -- Diagnostic summary (factorio log only). `unplaced` over-reports on merged segments — the transfer gate's
    -- whole-surface physical count is the authoritative arbiter of real loss (proven: gate −8 vs per-line 507).
    log(string.format(
        "[Import] Belt restoration complete. %d belts: expected=%d placed=%d unplaced_diag=%d (per-line; gate authoritative)",
        belt_count, expected_total, placed_count, unplaced_diag))

    return {
        belts_processed = belt_count,
        items_restored = placed_count,
        expected_total = expected_total,
    }
end

return BeltRestoration
