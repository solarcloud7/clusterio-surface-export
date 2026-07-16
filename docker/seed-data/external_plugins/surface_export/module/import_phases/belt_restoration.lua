local GameUtils = require("modules/surface_export/utils/game-utils")
local Util = require("modules/surface_export/utils/util")
local VersionCompat = require("modules/surface_export/utils/version-compat")

local BeltRestoration = {}

local QUALITY_NORMAL = GameUtils.QUALITY_NORMAL

-- insert_at's minimum lengthwise spacing between item groups (~0.25 on turbo). A captured line whose slots are
-- packed tighter than this (a backed-up belt at max compression) CANNOT be rebuilt slot-by-slot — insert_at
-- rejects the over-compressed tail (the documented −8/−143 floor). Detected purely from the CAPTURED positions
-- + dest line_length, so no runtime per-line measurement (which is unreliable on merged segments → the 267
-- phantom drops / the +108 duplication). See tests/belt-lab/NOTEBOOK.md.
local MIN_SPACING = 0.24

-- True if the sorted captured slots can't be placed at insert_at's min spacing within the dest line.
local function line_needs_consolidation(sorted_slots, len)
    local n = #sorted_slots
    if n == 0 then return false end
    -- TOO MANY SLOTS to place at min spacing within the line — even if every individual adjacent gap looks
    -- OK, N groups need ~(N)·MIN_SPACING of length. This catches the busy-case miss the pairwise-adjacent
    -- check below does NOT: a line (esp. a short curve/underground lane) carrying more item-groups than fit,
    -- where greedy forward-packing would push the tail past the end → per-slot drop. (consolidate_reject=0 on
    -- CI proved consolidation always places; the loss is lines that BYPASS it — this closes that gap.)
    if n * MIN_SPACING > len then return true end
    local prev = nil
    for _, item in ipairs(sorted_slots) do
        local p = item.position
        if not p then return false end                -- no position → insert_at_back path handles it
        if p > len then return true end               -- captured past the dest line end
        if prev and (p - prev) < MIN_SPACING then return true end
        prev = p
    end
    return false
end

local function add_items(totals, items)
    local total = 0
    for _, item in ipairs(items or {}) do
        local count = item.count or 0
        local key = Util.make_quality_key(item.name, item.quality or QUALITY_NORMAL)
        totals[key] = (totals[key] or 0) + count
        total = total + count
    end
    return total
end

local function live_line_items(line)
    local items = {}
    for _, item_data in ipairs(line.get_detailed_contents()) do
        local stack = item_data.stack
        if stack and stack.valid_for_read then
            items[#items + 1] = { name = stack.name, quality = stack.quality and stack.quality.name or QUALITY_NORMAL,
                count = stack.count, position = item_data.position }
        end
    end
    return items
end

local function neighbour_units(entity)
    local result = { inputs = {}, outputs = {} }
    local ok, neighbours = pcall(function() return entity.belt_neighbours end)
    if not ok or not neighbours then return result end
    for _, neighbour in pairs(neighbours.inputs or {}) do result.inputs[#result.inputs + 1] = neighbour.unit_number end
    for _, neighbour in pairs(neighbours.outputs or {}) do result.outputs[#result.outputs + 1] = neighbour.unit_number end
    table.sort(result.inputs); table.sort(result.outputs)
    return result
end

--- Census serialized-vs-live belt contents by physical entity and transport-line index.
--- Called after restoration and again at the frozen gate point; insert return values are never evidence.
function BeltRestoration.attribute_lines(entities_to_create, entity_map)
    local attribution = { rows = {}, expected = {}, actual = {}, expected_total = 0, actual_total = 0 }
    for _, entity_data in ipairs(entities_to_create or {}) do
        local entity = entity_map[entity_data.entity_id]
        if entity and entity.valid and GameUtils.BELT_ENTITY_TYPES[entity.type] then
            local expected_lines = {}
            for _, line_data in ipairs((entity_data.specific_data and entity_data.specific_data.items) or {}) do expected_lines[line_data.line] = line_data end
            local neighbours = neighbour_units(entity)
            for line_index = 1, entity.get_max_transport_line_index() do
                local line = entity.get_transport_line(line_index)
                if line and line.valid then
                    local line_data = expected_lines[line_index] or { line = line_index, items = {} }
                    local expected, actual = {}, {}
                    local expected_total = add_items(expected, line_data.items)
                    local actual_items = live_line_items(line)
                    local actual_total = add_items(actual, actual_items)
                    local delta, keys = {}, {}
                    for key in pairs(expected) do keys[key] = true end
                    for key in pairs(actual) do keys[key] = true end
                    for key in pairs(keys) do local value = (actual[key] or 0) - (expected[key] or 0); if value ~= 0 then delta[key] = value end end
                    attribution.expected_total = attribution.expected_total + expected_total
                    attribution.actual_total = attribution.actual_total + actual_total
                    for key, value in pairs(expected) do attribution.expected[key] = (attribution.expected[key] or 0) + value end
                    for key, value in pairs(actual) do attribution.actual[key] = (attribution.actual[key] or 0) + value end
                    attribution.rows[#attribution.rows + 1] = {
                        unit_number = entity.unit_number, entity_id = entity_data.entity_id, entity_name = entity.name,
                        entity_type = entity.type, position = { x = entity.position.x, y = entity.position.y },
                        direction = entity.direction, line_index = line_index, line_length = line.line_length,
                        neighbours = neighbours, compression = line_needs_consolidation(line_data.items or {}, line.line_length),
                        expected = expected, actual = actual, delta = delta,
                        expected_items = line_data.items or {}, actual_items = actual_items,
                    }
                end
            end
        end
    end
    attribution.delta = attribution.actual_total - attribution.expected_total
    return attribution
end
--- Move only whole-belt aggregate deficits to the hub. Per-window insert deltas are unsound on merged lines;
--- the completed census is the same meter used by the frozen exact gate. A partial hub insert remains visible
--- as unrecovered so the gate still fails closed.
--- PUBLIC and called LATE (import-completion, after BOTH inventory passes) — BELT-R3/R5
--- [empirical, 2.0.77, tests/belt-lab/NOTEBOOK.md]: when this ran inside restore(), Pass 2 inventory
--- restoration re-cleared the hub two phases later and silently WIPED the recovered items; recovery
--- reported success while the strict gate physically counted them missing.
function BeltRestoration.recover_deficits_to_hub(attribution, entities_to_create, entity_map)
    local recovery = { recovered = {}, unrecovered = {}, recovered_total = 0, unrecovered_total = 0 }
    local hub = nil
    for _, entity_data in ipairs(entities_to_create or {}) do
        local entity = entity_map[entity_data.entity_id]
        if entity and entity.valid and entity.name == "space-platform-hub" then hub = entity; break end
    end
    local hub_inventory = hub and hub.get_inventory(defines.inventory.hub_main) or nil
    for key, expected in pairs(attribution.expected or {}) do
        local deficit = expected - (attribution.actual[key] or 0)
        if deficit > 0 then
            local inserted = 0
            if hub_inventory and hub_inventory.valid then
                local item_name, quality = Util.parse_quality_key(key)
                inserted = hub_inventory.insert({ name = item_name, count = deficit, quality = quality })
            end
            if inserted > 0 then recovery.recovered[key] = inserted; recovery.recovered_total = recovery.recovered_total + inserted end
            local remainder = deficit - inserted
            if remainder > 0 and hub then
                local item_name, quality = Util.parse_quality_key(key)
                -- Count what PHYSICALLY materialized, not whether the call threw. [empirical, 2.0.77,
                -- BELT-R3 in tests/belt-lab/NOTEBOOK.md]: with a full hub, this spill returned
                -- without error but created ZERO item-entities on the platform — the old "didn't throw =
                -- recovered" accounting reported recovered=5/unrecovered=0 while the strict gate physically
                -- counted all 5 missing. Sum the returned entities' stack counts; only that is recovered.
                local spill_ok, spilled_or_err = pcall(function()
                    return hub.surface.spill_item_stack({
                        position = hub.position,
                        stack = { name = item_name, count = remainder, quality = quality },
                    })
                end)
                if spill_ok then
                    local materialized = 0
                    for _, spilled_entity in ipairs(spilled_or_err or {}) do
                        if spilled_entity.valid and spilled_entity.stack and spilled_entity.stack.valid_for_read then
                            materialized = materialized + spilled_entity.stack.count
                        end
                    end
                    if materialized > 0 then
                        recovery.recovered[key] = (recovery.recovered[key] or 0) + materialized
                        recovery.recovered_total = recovery.recovered_total + materialized
                    end
                    if materialized < remainder then
                        log(string.format("[Belt Restore] Hub-full deficit spill for %s: requested %d, materialized %d",
                            key, remainder, materialized))
                    end
                    remainder = remainder - materialized
                else
                    log(string.format("[Belt Restore] Hub-full deficit spill failed for %s x%d: %s",
                        key, remainder, tostring(spilled_or_err)))
                end
            end
            if remainder > 0 then recovery.unrecovered[key] = remainder; recovery.unrecovered_total = recovery.unrecovered_total + remainder end
        end
    end
    if recovery.recovered_total > 0 or recovery.unrecovered_total > 0 then
        log(string.format("[Belt Restore] Aggregate deficit recovery: recovered=%d to hub/ground, unrecovered=%d",
            recovery.recovered_total, recovery.unrecovered_total))
    end
    return recovery
end
--- Restore all belt items synchronously in a single tick.
--- CRITICAL: Belts are always active and cannot be deactivated, so items must be restored all at once.
---
--- Factorio 2.0.76 LuaTransportLine API (signature routed through version-compat.lua; source of truth is
--- lua-api.factorio.com/2.0.76/, NOT the "latest" docs which reorder the params):
---     insert_at(position, items, belt_stack_size?) -> bool     (position FIRST; belt_stack_size caps the slot)
---
--- THE FIX (verified empirically — belt-lab R1a/R1b, commit ce9f90a; apples-to-apples, on the pinned engine):
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

    -- Opt-in diagnostic (default OFF, zero prod impact; set storage.surface_export_config.belt_diag=true):
    -- classify each dropped item as GEOMETRY (captured pos beyond the dest line's end — source lane was
    -- longer, e.g. a curve outside-lane) vs COMPRESSION (in-bounds but too tight for insert_at's ~0.25 min
    -- spacing). Decides whether multi-tick (helps compression only) can reach literal-zero, or whether the
    -- loss is geometry (needs dest-geometry preservation instead). See tests/belt-lab/NOTEBOOK.md.
    local diag = storage.surface_export_config and storage.surface_export_config.belt_diag == true
    local geom_items, comp_items, other_items, nopos_items = 0, 0, 0, 0

    -- Oversized-stack consolidation: over-compressed lines (whose captured slots are packed tighter than
    -- insert_at's min spacing — the −8/−143 floor) are rebuilt as one oversized stack per (name,quality)
    -- instead of dropping the un-placeable tail. insert_at accepts an arbitrary belt_stack_size and the engine
    -- keeps it — VERIFIED end-to-end: survives save/load, gate reports literal-zero with no duplication, and
    -- post-activation loss-analysis is ZERO (a powered factory draining the over-stacks conserves). ON by
    -- default (preserving items beats cosmetic layout; the belt self-heals as the factory pulls). Set
    -- storage.surface_export_config.belt_consolidate=false to fall back to the lossy −8 floor.
    local consolidate_enabled = not (storage.surface_export_config and storage.surface_export_config.belt_consolidate == false)
    local consolidated_lines = 0
    local consolidate_reject_count = 0   -- consolidated groups insert_at rejected (always tracked — the busy-case signal)
    local consolidate_reject_total = 0   -- items in those rejected groups

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

                if consolidate_enabled and line_needs_consolidation(slots, line.line_length) then
                    -- Over-compressed line: group items by (name,quality) and place each group as ONE oversized
                    -- stack at a spread position. insert_at takes an arbitrary belt_stack_size, so all items fit
                    -- → zero loss (vs dropping the over-compressed tail). Positions are cosmetic on a maxed belt
                    -- and self-heal as the factory pulls items. Deterministic (no per-line measurement → no dup).
                    local groups, order = {}, {}
                    for _, item in ipairs(slots) do
                        local q = item.quality or QUALITY_NORMAL
                        local key = item.name .. "\0" .. q
                        local g = groups[key]
                        if not g then g = { name = item.name, quality = q, count = 0 }; groups[key] = g; order[#order + 1] = key end
                        g.count = g.count + item.count
                    end
                    local len = line.line_length
                    for gi, key in ipairs(order) do
                        local g = groups[key]
                        local pos = math.min((gi - 1) * 0.25, len - 0.05)
                        local before = line.get_item_count()
                        local ok, ret = pcall(function()
                            return VersionCompat.belt_insert_at(line, pos, { name = g.name, count = g.count, quality = g.quality }, g.count)
                        end)
                        if not ok then
                            log(string.format("[Belt Restore] consolidate insert ERROR on %s line %d: %s",
                                entity.name, line_data.line, tostring(ret)))
                        end
                        placed_count = placed_count + (line.get_item_count() - before)
                        -- A false return = the consolidated group was REJECTED (likely a multi-type line where
                        -- N groups × 0.25 overran the line, or two types within 0.25). This is exactly the
                        -- busy-case failure mode single-type over-compression doesn't show. Track always.
                        if ret == false then
                            consolidate_reject_count = consolidate_reject_count + 1
                            consolidate_reject_total = consolidate_reject_total + g.count
                            if diag then
                                log(string.format("[BeltDiag] CONSOLIDATE-REJECT: %s x%d at pos=%.4f line_len=%.4f group %d/%d on %s line %d",
                                    g.name, g.count, pos, len, gi, #order, entity.name, line_data.line))
                            end
                        end
                    end
                    consolidated_lines = consolidated_lines + 1
                else
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
                    -- NO per-slot recovery here. BELT-R4 [empirical, 2.0.77, tests/belt-lab/NOTEBOOK.md]:
                    -- a slot-merge triggered off this `placed < item.count` reading fired on the merged-
                    -- segment PHANTOM shorts (not just real drops) and duplicated +341 items on the replay
                    -- payload. The header rule — never route/re-insert off per-line measurements — applies
                    -- to recovery triggers too. Real deficits are recovered AGGREGATE-level (name-keyed,
                    -- from attribute_lines totals, the meter that matched the gate in both real failures)
                    -- by recover_deficits_to_hub below.
                    placed_count = placed_count + placed
                    if placed < item.count then
                        local short = item.count - placed
                        unplaced_diag = unplaced_diag + short
                        if diag then
                            local pos = item.position
                            local len = line.line_length
                            if not pos then
                                nopos_items = nopos_items + short
                            elseif pos > len then
                                geom_items = geom_items + short
                                log(string.format("[BeltDiag] GEOMETRY off-end: %s pos=%.4f > dest_len=%.4f (over %.4f) short=%d",
                                    item.name, pos, len, pos - len, short))
                            else
                                local nearest = 999
                                for _, e in ipairs(line.get_detailed_contents()) do
                                    local d = math.abs(e.position - pos); if d < nearest then nearest = d end
                                end
                                if nearest < 0.25 then
                                    comp_items = comp_items + short
                                    log(string.format("[BeltDiag] COMPRESSION: %s pos=%.4f dest_len=%.4f nearest=%.4f short=%d",
                                        item.name, pos, len, nearest, short))
                                else
                                    other_items = other_items + short
                                    log(string.format("[BeltDiag] OTHER inbounds: %s pos=%.4f dest_len=%.4f nearest=%.4f short=%d",
                                        item.name, pos, len, nearest, short))
                                end
                            end
                        end
                    end
                end
                end
            end
        end

        ::continue::
    end

    local attribution = BeltRestoration.attribute_lines(entities_to_create, entity_map)
    -- Deficit recovery is NOT called here. It moved to import-completion AFTER the inventory passes
    -- (see recover_deficits_to_hub's header) — anything inserted into the hub from this phase is
    -- wiped by the Pass-2 hub inventory clear()+refill.
    unplaced_diag = math.max(0, -attribution.delta)
    log(string.format(
        "[Import] Belt restoration complete. %d belts: expected=%d actual=%d delta=%d consolidated_lines=%d",
        belt_count, attribution.expected_total, attribution.actual_total, attribution.delta, consolidated_lines))

    -- Surface consolidation rejects to the cluster log (game.print mirrors to factorio log → cluster log,
    -- which CI captures even when belt_diag is off). consolidate_reject_total > 0 means the oversized-stack
    -- fix could not place some groups — the busy-case signal we can't otherwise see from CI.
    if consolidate_reject_count > 0 then
        game.print(string.format("[BeltConsolidate] %d groups REJECTED (%d items) across %d consolidated lines",
            consolidate_reject_count, consolidate_reject_total, consolidated_lines), { 1, 0.5, 0 })
    end

    if diag then
        log(string.format("[BeltDiag] SUMMARY unplaced=%d -> geometry=%d compression=%d other=%d nopos=%d",
            unplaced_diag, geom_items, comp_items, other_items, nopos_items))
        -- game.print mirrors to the factorio log → cluster log → CI capture (log() above does NOT reach CI).
        game.print(string.format("[BeltDiag] unplaced=%d geom=%d comp=%d other=%d | consolidated_lines=%d reject=%d(%d items)",
            unplaced_diag, geom_items, comp_items, other_items, consolidated_lines, consolidate_reject_count, consolidate_reject_total), { 0.6, 0.8, 1 })
    end

    return {
        belts_processed = belt_count,
        items_restored = placed_count,
        expected_total = expected_total,
        attribution = attribution,
    }
end

return BeltRestoration
