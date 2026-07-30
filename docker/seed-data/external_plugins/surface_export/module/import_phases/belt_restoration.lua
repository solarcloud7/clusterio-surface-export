local GameUtils = require("modules/surface_export/utils/game-utils")
local Util = require("modules/surface_export/utils/util")
local VersionCompat = require("modules/surface_export/utils/version-compat")

local BeltRestoration = {}

local QUALITY_NORMAL = GameUtils.QUALITY_NORMAL

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
--- FORENSIC INSTRUMENT ONLY (its restore-path consumers — the legacy consolidation restore and
--- hub-deficit recovery — were DELETED 2026-07-27, owner order): the failure black box banks this
--- per-line expected-vs-actual attribution as evidence before a failed destination is discarded.
--- Insert return values are never evidence.
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
                        neighbours = neighbours,
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
-- === Captured-source-position side-scoped restore (BELT-R10..R12, R16) ====================================
-- The canonical belt laws live in docs/factorio-2.0-api-notes.md "Belt transport-line laws
-- (CANONICAL)". capture_side_groups + restore_side_groups are THE belt restore — the ONLY
-- placement path (owner order 2026-07-27: the legacy captured-position + consolidation restore,
-- hub-deficit recovery, and the first-fit fallback are DELETED; a payload without
-- item_source_positions is REFUSED at import). Consumers: the transfer/upload import, selection-lab paste, and the
-- selftest instruments.

-- Shape validator for a payload's belt_side_groups (review finding F1, 2026-07-27): the restore
-- runs in on_tick context where an uncaught throw KILLS the headless server (exit 255, measured
-- twice), and upload-import payloads are user-supplied JSON that the schema check never inspects
-- beyond schema_version. The import REFUSES a payload failing this (through the verdict, never
-- error()). Pure SHAPE only — content problems (unknown prototypes at the destination) are
-- handled gracefully inside the restore itself.
function BeltRestoration.validate_side_groups(side_groups)
    if type(side_groups) ~= "table" then return false, "belt_side_groups is not a table" end
    for gi, g in ipairs(side_groups) do
        if type(g) ~= "table" then return false, "group " .. gi .. " is not a table" end
        if type(g.members) ~= "table" then return false, "group " .. gi .. " has no members table" end
        if type(g.slots) ~= "table" then return false, "group " .. gi .. " has no slots table" end
        for mi, m in ipairs(g.members) do
            if type(m) ~= "table" or m.id == nil or type(m.li) ~= "number" then
                return false, string.format("group %d member %d malformed", gi, mi)
            end
        end
        for si, slot in ipairs(g.slots) do
            if type(slot) ~= "table" or type(slot.n) ~= "string"
                or type(slot.ct) ~= "number" or slot.ct <= 0
                or (slot.q ~= nil and type(slot.q) ~= "string") then
                return false, string.format("group %d slot %d malformed", gi, si)
            end
        end
        -- item_source_positions is REQUIRED (owner order 2026-07-27: no fallback path) — exactly
        -- three numbers per slot. A payload without it fails here and the import refuses it;
        -- re-export from the source with the current version.
        if type(g.item_source_positions) ~= "table" or #g.item_source_positions ~= 3 * #g.slots then
            return false, string.format("group %d item_source_positions missing or misaligned (need %d values, got %s) — payloads without captured source positions are no longer importable, re-export from the source",
                gi, 3 * #g.slots, type(g.item_source_positions) == "table" and tostring(#g.item_source_positions) or type(g.item_source_positions))
        end
        for vi, v in ipairs(g.item_source_positions) do
            if type(v) ~= "number" then
                return false, string.format("group %d item_source_positions[%d] is not a number", gi, vi)
            end
        end
    end
    return true
end

-- Same-execution line_equals partition of a POPULATED source = the lane sides (valid ONLY
-- populated + same execution — never a cross-import key, BELT-R9). belt_pairs: array of
-- { entity = <LuaEntity>, id = <the record entity_id the paste/import will key entity_map by> }.
-- Returns storage-safe side groups: { { members = {{id=,li=},...}, slots = {{n=,q=,ct=},...} }, ... }
function BeltRestoration.capture_side_groups(belt_pairs)
    if not belt_pairs or #belt_pairs == 0 then return nil end
    -- CAPTURED SOURCE POSITIONS (owner ruling 2026-07-27, PRODUCTION — supersedes the earlier debug-gate
    -- scoping): each side carries a compact flat array `item_source_positions` = { id1, li1, k1, id2, li2, k2, … },
    -- three numbers per slot in slot order — the source entity, transport-line index, and exact
    -- position (1/256ths) the slot was captured from. Restore seats each item back onto its OWN
    -- line at its OWN position (each item placed back at its captured source position), which is what kills the boundary-handoff duplication
    -- class; the reconciliation instrument reads the same data. Compact by design: numbers only,
    -- one field name per side — the per-slot {id,li,k} object form nearly doubled the workhorse
    -- payload. Zero extra reads: the loop already holds all three values.
    local groups = {}
    for _, bp in ipairs(belt_pairs) do
        for li = 1, bp.entity.get_max_transport_line_index() do
            local line = bp.entity.get_transport_line(li)
            local gi
            for j, g in ipairs(groups) do
                if line.line_equals(g.rep) then gi = j break end
            end
            if not gi then
                gi = #groups + 1
                groups[gi] = { rep = line, seen = {}, members = {}, slots = {}, item_source_positions = {} }
            end
            local g = groups[gi]
            g.members[#g.members + 1] = { id = bp.id, li = li }
            for _, it in ipairs(line.get_detailed_contents()) do
                local uid = tostring(it.unique_id)
                if not g.seen[uid] then
                    g.seen[uid] = true
                    g.slots[#g.slots + 1] = {
                        n = it.stack.name,
                        q = (it.stack.quality and it.stack.quality.name) or QUALITY_NORMAL,
                        ct = it.stack.count,
                    }
                    local s = g.item_source_positions
                    s[#s + 1] = bp.id
                    s[#s + 1] = li
                    s[#s + 1] = math.floor((it.position or 0) * 256 + 0.5)
                end
            end
        end
    end
    local out = {}
    for _, g in ipairs(groups) do
        out[#out + 1] = { members = g.members, slots = g.slots, item_source_positions = g.item_source_positions }
    end
    return out
end

-- Place each side's (name,quality,count) multiset AT CAPTURED SOURCE POSITIONS — each slot back onto its own
-- captured line at its own captured position (rehydrated from the side's compact
-- item_source_positions array),
-- request floored at one tick of belt_speed (BELT-R10 — the write-frame law). There is NO
-- fallback placement (owner order 2026-07-27): a slot whose captured source position cannot place is honest unplaced
-- loss the exact gate refuses. Every placement is validated by a physical SIDE-census delta
-- (never insert_at return values), and the WHOLE restore is bracketed by ONE global before/after
-- census that must equal the placed sums key-for-key — any mismatch is a loud anomaly. No
-- consolidation, no recovery, no legacy path.
--
-- SCALE (owner ruling 2026-07-26; the "perf measure-first" adjudication vindicated live): the
-- original implementation took TWO global snapshots inside the innermost placement loop for
-- per-placement cross-side leak undo. At workhorse scale (5,776 slots x ~1,200 line reads per
-- snapshot) that is ~14M engine calls in one tick — measured as a hard import stall. The leak
-- class it undid is the AGED-HANDLE class (BELT-R12): a handle whose segment reshaped under it.
-- Every handle here is fetched fresh in THIS execution (below) and no belt topology mutates
-- during placement, so the aging mechanism cannot occur (R14 live 2026-07-26: 372/372,
-- leaks 0, anomalies 0). Leak detection therefore moves to the restore-granularity bracket: a
-- leak can no longer be attributed to one placement and undone, but it can NEVER pass silently —
-- the bracket mismatch is an anomaly the callers treat as failure. Cost: O(slots x side + lines).
--
-- MULTI-STACK (owner requirement 2026-07-26): a slot's ct places as ONE stack of ct — a stack of
-- 2 restores as a stack of 2. The multiset IS (name, quality, stack count); nothing clamps.
-- Line handles are fetched HERE, in the same execution that writes them (stale-handle hazard).
-- Returns placed, unplaced, anomalies.
function BeltRestoration.restore_side_groups(side_groups, entity_map)
    -- Handle freshness is per-READ, not per-function: ~20k inserts split segments, and a handle
    -- fetched before a split is AGED — an aged read double-sees items (BELT-R12 applied to the
    -- WITNESS itself; measured live 2026-07-27: phantom +2/+16 bracket excesses on the workhorse
    -- import while the independent dup_kill verdict was 19,696/19,696 exact). The global bracket
    -- therefore re-fetches every line handle at each snapshot instant.
    local function fresh_all_lines()
        local lines = {}
        for _, g in ipairs(side_groups) do
            for _, m in ipairs(g.members) do
                local entity = entity_map[m.id]
                if entity and entity.valid then lines[#lines + 1] = entity.get_transport_line(m.li) end
            end
        end
        return lines
    end
    local function item_key(name, quality)
        return name .. "\0" .. (quality or QUALITY_NORMAL)
    end
    local function snapshot(lines)
        local result = { total = 0, by_key = {}, by_id = {} }
        for _, line in ipairs(lines) do
            for _, item in ipairs(line.get_detailed_contents()) do
                local id = tostring(item.unique_id)
                if not result.by_id[id] then
                    local quality = (item.stack.quality and item.stack.quality.name) or QUALITY_NORMAL
                    local key = item_key(item.stack.name, quality)
                    local count = item.stack.count
                    result.by_id[id] = { key = key, count = count }
                    result.by_key[key] = (result.by_key[key] or 0) + count
                    result.total = result.total + count
                end
            end
        end
        return result
    end
    local function changed_only(before, after, wanted_key, wanted_delta)
        local keys = {}
        for key in pairs(before.by_key) do keys[key] = true end
        for key in pairs(after.by_key) do keys[key] = true end
        for key in pairs(keys) do
            local delta = (after.by_key[key] or 0) - (before.by_key[key] or 0)
            if delta ~= (key == wanted_key and wanted_delta or 0) then return false end
        end
        return after.total - before.total == wanted_delta
    end
    local function same_snapshot(a, b)
        return changed_only(a, b, "", 0)
    end
    -- (undo_inserted_delta is GONE with the per-placement leak machinery — see the header. The
    -- BELT-R15 pure-read-before-mutate lesson it carried lives on in api-notes' AGED-TARGET entry.)
    local global_before = snapshot(fresh_all_lines())
    local expected_by_key = {}
    local placed, unplaced, anomalies = 0, 0, 0
    -- PLACEMENT LEDGER (owner direction 2026-07-27): every validated landing is recorded —
    -- { e = <dest entity>, li, k = <requested 1/256 position>, slot } — so the reconciliation
    -- pass below can match each PHYSICAL destination item back to the placement that made it
    -- (and through slot.src, back to its SOURCE seat). In-memory only, never rides a payload.
    local ledger = {}
    local unplaced_list = {}
    local unknown_logged = 0
    -- Rehydrate the payload's compact item_source_positions array (see capture_side_groups) into per-slot
    -- src = { id, li, k } working form. item_source_positions is REQUIRED on the production path
    -- (the validator refuses payloads without it); this guard covers direct callers (selftest instruments,
    -- selection-lab) — a slot left without src is honest unplaced loss, there is no fallback.
    for _, g in ipairs(side_groups) do
        if type(g.item_source_positions) == "table" and #g.item_source_positions % 3 == 0 then
            for si, slot in ipairs(g.slots) do
                local base = (si - 1) * 3
                local id = g.item_source_positions[base + 1]
                if id ~= nil then
                    slot.src = { id = id, li = g.item_source_positions[base + 2], k = g.item_source_positions[base + 3] }
                end
            end
        elseif g.item_source_positions ~= nil then
            log(string.format("[BeltRestoration] item_source_positions misaligned (len %d) — group's slots will be UNPLACED",
                type(g.item_source_positions) == "table" and #g.item_source_positions or -1))
        end
    end
    -- Slots whose captured-line scan exhausted; the over-compression merge pass below owns them
    -- (recorded with their side group so the merge validates through the same side census).
    local pending = {}
    for _, g in ipairs(side_groups) do
        -- Lines are fetched fresh at every use, never stored: a side's own inserts split its
        -- segments, and both READS and WRITES through a pre-split handle are the aged-handle
        -- class (R12).
        local function side_total()
            local lines = {}
            for _, m in ipairs(g.members) do
                local entity = entity_map[m.id]
                if entity and entity.valid then lines[#lines + 1] = entity.get_transport_line(m.li) end
            end
            return snapshot(lines)
        end
        -- One validated insert. Returns true (landed, ledgered), false (landed WRONG — anomaly,
        -- abandon slot), or nil (nothing landed anywhere — the fresh-handle regime guarantee —
        -- keep scanning; if something DID land elsewhere the final bracket surfaces it, never
        -- silently).
        local function try_insert(line, w_entity, w_li, k, slot, wanted_key)
            if not line.can_insert_at(k / 256) then return nil end
            local sb = side_total()
            -- Through the version seam (review F3): the seam exists because "latest" docs reorder
            -- insert_at's parameters and using that order on 2.0.76 places nothing — production
            -- belt writes must not bypass it. slot.ct as belt_stack_size seats an oversized
            -- (fossil) stack as ONE stack — the multi-stack owner requirement.
            VersionCompat.belt_insert_at(line, k / 256, { name = slot.n, quality = slot.q, count = slot.ct }, slot.ct)
            local sa = side_total()
            if changed_only(sb, sa, wanted_key, slot.ct) then
                placed = placed + slot.ct
                expected_by_key[wanted_key] = (expected_by_key[wanted_key] or 0) + slot.ct
                ledger[#ledger + 1] = { e = w_entity, li = w_li, k = k, slot = slot }
                return true
            elseif same_snapshot(sb, sa) then
                return nil
            else
                anomalies = anomalies + 1
                return false
            end
        end
        for _, slot in ipairs(g.slots) do
          -- Prototype-existence screen (review F1b): a belt item from a mod the DESTINATION lacks
          -- must not reach insert_at (a throw here is server death in on_tick). Skip gracefully —
          -- the shortfall is honest unplaced loss: strict transfers fail the exact gate => revert;
          -- the loose upload path reports it (the documented mod-mismatch posture).
          if not prototypes.item[slot.n] or (slot.q and not prototypes.quality[slot.q]) then
            unplaced = unplaced + slot.ct
            unplaced_list[#unplaced_list + 1] = slot
            unknown_logged = unknown_logged + 1
            if unknown_logged <= 10 then
                log(string.format("[BeltRestoration] UNKNOWN PROTOTYPE %s (quality %s) x%d — skipped, counts as unplaced",
                    slot.n, tostring(slot.q), slot.ct))
            end
          else
            local done = false
            local wanted_key = item_key(slot.n, slot.q)
            if slot.src then
                -- CAPTURED SOURCE POSITION placement (production, owner ruling 2026-07-27): scan DOWN
                -- from the captured position — request = src.k minus one write-frame, so the landing
                -- (request + one tick of belt_speed, BELT-R10) comes out at the captured position —
                -- putting the item on its
                -- OWN line as close to its original position as capacity allows. This is what kills
                -- the boundary-handoff class: first-fit's top-of-line writes seated items across
                -- piece boundaries (underground internal lines at k=kfloor), duplicating on
                -- census-invisible cross-side handoffs (measured live 2026-07-27; source-position
                -- run: 5777/5777 same-line, BORN 0, full exact gate PASS). src belongs to this same
                -- group by construction, so side_total() covers the write.
                local se = entity_map[slot.src.id]
                if se and se.valid then
                    local skmin = math.floor(se.prototype.belt_speed * 256 + 0.5)
                    local sline = se.get_transport_line(slot.src.li)
                    local top = math.floor(sline.line_length * 256 + 0.5)
                    local want = math.min(top, math.max(skmin, (slot.src.k or skmin) - skmin))
                    for k = want, skmin, -1 do
                        local r = try_insert(sline, se, slot.src.li, k, slot, wanted_key)
                        if r ~= nil then
                            done = true
                            break
                        end
                    end
                    -- A scan-exhausted slot goes to the OVER-COMPRESSION MERGE pass below —
                    -- never straight to unplaced.
                end
            end
            -- A slot whose captured line cannot hold it goes to the over-compression merge pass
            -- below; anything that pass cannot place is honest unplaced loss. The reverse
            -- first-fit window fallback that used to catch this is the machinery whose
            -- top-of-line writes caused the BELT-R16 boundary-handoff duplication class — it stays
            -- deleted.
            if not done then
                pending[#pending + 1] = { slot = slot, g = g }
            end
          end
        end
    end
    -- OVER-COMPRESSION MERGE (owner ruling 2026-07-27: a platform must transfer WHENEVER —
    -- refusing a live capture is not acceptable — and the remedy is the ESTABLISHED oversized-stack
    -- law, not a new placement concept). The engine under pressure packs a line tighter than
    -- insert_at can recreate: measured from the banked black box, a 1-tile turbo line captured
    -- with FIVE items, the front one 14/256 behind its neighbour — the same class as the historic
    -- legacy belt floor. The tested engine fact (api-notes; the fix that took that floor to zero):
    -- insert_at accepts an arbitrary belt_stack_size and the engine KEEPS the oversized stack.
    -- So an unplaceable slot MERGES into an already-placed stack of the SAME (name, quality) on
    -- its OWN captured line — remove that stack, re-insert at the same position with the combined
    -- count as ONE oversized stack — validated by the same side census as every other write, and
    -- self-healing as the factory drains the lane. Same line, same item; no cross-side placement,
    -- no graph reasoning. A slot with no same-item partner on its line stays honest unplaced loss.
    for _, entry in ipairs(pending) do
        local slot, g = entry.slot, entry.g
        local done = false
        local se = slot.src and entity_map[slot.src.id]
        if se and se.valid then
            local wanted_key = item_key(slot.n, slot.q)
            local partner
            for _, ledger_entry in ipairs(ledger) do
                if ledger_entry.e == se and ledger_entry.li == slot.src.li
                    and item_key(ledger_entry.slot.n, ledger_entry.slot.q) == wanted_key then
                    partner = ledger_entry
                end
            end
            if partner then
                local function side_total_merge()
                    local lines = {}
                    for _, m in ipairs(g.members) do
                        local e2 = entity_map[m.id]
                        if e2 and e2.valid then lines[#lines + 1] = e2.get_transport_line(m.li) end
                    end
                    return snapshot(lines)
                end
                -- Scan-place a stack near the partner's position: down from it first, then up,
                -- staying one write-frame short of the line end (the BELT-R16 handoff zone). A
                -- FRESH line handle per call — remove_item reshapes the line, and both reads and
                -- writes through a pre-mutation handle are the aged-handle class (this exact
                -- pattern failed live with a fixed-position re-insert before this scan existed).
                -- Returns the request k it inserted at (nil if nothing fit).
                local function scan_place(count)
                    local mline = se.get_transport_line(slot.src.li)
                    local mkmin = math.floor(se.prototype.belt_speed * 256 + 0.5)
                    local mtop = math.floor(mline.line_length * 256 + 0.5)
                    for k = math.min(partner.k, mtop - mkmin), mkmin, -1 do
                        if mline.can_insert_at(k / 256) then
                            VersionCompat.belt_insert_at(mline, k / 256,
                                { name = slot.n, quality = slot.q, count = count }, count)
                            return k
                        end
                    end
                    for k = partner.k + 1, mtop - mkmin do
                        if mline.can_insert_at(k / 256) then
                            VersionCompat.belt_insert_at(mline, k / 256,
                                { name = slot.n, quality = slot.q, count = count }, count)
                            return k
                        end
                    end
                end
                local merged_ct = partner.slot.ct + slot.ct
                local sb = side_total_merge()
                local removed = se.get_transport_line(slot.src.li).remove_item(
                    { name = slot.n, quality = slot.q, count = partner.slot.ct })
                local landed_k = nil
                if removed == partner.slot.ct then
                    landed_k = scan_place(merged_ct)
                end
                local sa = side_total_merge()
                if changed_only(sb, sa, wanted_key, slot.ct) then
                    placed = placed + slot.ct
                    expected_by_key[wanted_key] = (expected_by_key[wanted_key] or 0) + slot.ct
                    -- One merged oversized stack now carries both slots — update the ledger entry
                    -- so the reconciliation matches the physical stack it will actually find.
                    partner.slot = { n = slot.n, q = slot.q, ct = merged_ct, src = partner.slot.src }
                    -- Review F4: record the merged stack's actual landing so the reconciliation
                    -- does not report it as spurious BORN + VANISHED.
                    if landed_k then partner.k = landed_k end
                    log(string.format(
                        "[BeltRestoration] OVER-COMPRESSION MERGE: %s x%d joined the stack near entity %s line %d (now x%d) — engine packed tighter than insert_at can recreate",
                        slot.n, slot.ct, tostring(slot.src.id), slot.src.li, merged_ct))
                    done = true
                else
                    -- The merge did not land exactly. Put the partner stack back (if removed) and
                    -- re-check; any residue is an anomaly the verdict refuses.
                    if removed > 0 then
                        scan_place(removed)
                    end
                    local sr = side_total_merge()
                    if same_snapshot(sb, sr) then
                        log(string.format(
                            "[BeltRestoration] OVER-COMPRESSION MERGE could not land for %s x%d — partner restored, slot stays unplaced",
                            slot.n, slot.ct))
                    else
                        anomalies = anomalies + 1
                        log(string.format(
                            "[BeltRestoration] OVER-COMPRESSION MERGE left residue for %s x%d (removed=%d) — anomaly, verdict will refuse",
                            slot.n, slot.ct, removed))
                    end
                end
            end
        end
        if not done then
            unplaced = unplaced + slot.ct
            unplaced_list[#unplaced_list + 1] = slot
        end
    end
    -- The restore-granularity bracket: the global physical delta must equal the placed sums for
    -- EVERY key, gains and absences alike. This is what catches anything the per-side deltas
    -- cannot attribute — including the mechanism-impossible-but-never-trusted cross-side leak.
    local global_after = snapshot(fresh_all_lines())
    local keys = {}
    for key in pairs(global_before.by_key) do keys[key] = true end
    for key in pairs(global_after.by_key) do keys[key] = true end
    for key in pairs(expected_by_key) do keys[key] = true end
    for key in pairs(keys) do
        local delta = (global_after.by_key[key] or 0) - (global_before.by_key[key] or 0)
        if delta ~= (expected_by_key[key] or 0) then
            anomalies = anomalies + 1
            log(string.format("[BeltRestoration] GLOBAL BRACKET MISMATCH %q: physical delta %d ~= placed %d",
                key, delta, expected_by_key[key] or 0))
        end
    end
    -- RECONCILIATION (dump v3, owner direction 2026-07-27 — replaces the uid-counting attribution
    -- dump, whose "new uid" totals rested on an unproven identity assumption): match every PHYSICAL
    -- item on the side lines to a recorded placement by (line, position, key) — position-based, so
    -- uid semantics never enter it. Each physical item is then exactly one of:
    --   TRACED       — matches a placement; through slot.src it names its SOURCE seat, and the
    --                  match says whether it stayed on its source line (same-line vs moved-line)
    --   PREEXISTING  — was on the lines before restore began (paste-over contexts)
    --   BORN-AT-DEST — nothing placed it (the defect's fingerprint), logged with coordinates
    -- and each unmatched placement is VANISHED. Tolerance = one write-frame + 2 (BELT-R10: a
    -- landing comes out at request + one tick of belt_speed, clamped inward at line ends).
    local dbg = storage.surface_export_config and storage.surface_export_config.debug_mode
    if dbg or anomalies > 0 then
        -- Identity + location helpers tolerant of minimal entities (the selftest drives this path
        -- with pure-Lua fakes that have no unit_number/name/position): unit_number when present,
        -- table/userdata identity otherwise; coordinates degrade to a bare name.
        local function line_key_of(entity, li)
            return tostring(entity.unit_number or entity) .. "/" .. li
        end
        local function loc(entity)
            local p = entity.position
            if p then
                return string.format("%s (%.1f, %.1f)", tostring(entity.name), p.x, p.y)
            end
            return tostring(entity.name)
        end
        local by_line = {}
        for _, p in ipairs(ledger) do
            if p.e.valid then
                local lk = line_key_of(p.e, p.li)
                local t = by_line[lk]
                if not t then
                    t = {}
                    by_line[lk] = t
                end
                t[#t + 1] = p
            end
        end
        local stats = { phys = 0, traced = 0, same_line = 0, moved_line = 0, no_src = 0,
            preexisting = 0, born = 0, vanished = 0, ct_drift = 0, aliased = 0 }
        local born_by_key, van_by_key = {}, {}
        local born_logged, van_logged, moved_logged = 0, 0, 0
        local dk_sum, dk_n, dk_max = 0, 0, 0
        local seen_recon = {}
        for _, g in ipairs(side_groups) do
            for _, m in ipairs(g.members) do
                local entity = entity_map[m.id]
                if entity and entity.valid then
                    local plist = by_line[line_key_of(entity, m.li)] or {}
                    local tol = math.floor(entity.prototype.belt_speed * 256 + 0.5) + 2
                    for _, it in ipairs(entity.get_transport_line(m.li).get_detailed_contents()) do
                        local uid = tostring(it.unique_id)
                        if seen_recon[uid] then
                            stats.aliased = stats.aliased + 1
                        else
                            seen_recon[uid] = true
                            stats.phys = stats.phys + 1
                            local kphys = math.floor((it.position or 0) * 256 + 0.5)
                            local q = (it.stack.quality and it.stack.quality.name) or QUALITY_NORMAL
                            local key = item_key(it.stack.name, q)
                            local best, bestd
                            for _, p in ipairs(plist) do
                                if not p.hit and item_key(p.slot.n, p.slot.q) == key then
                                    local d = math.abs(kphys - p.k)
                                    if d <= tol and (bestd == nil or d < bestd) then
                                        best, bestd = p, d
                                    end
                                end
                            end
                            if best then
                                best.hit = true
                                stats.traced = stats.traced + 1
                                if it.stack.count ~= best.slot.ct then
                                    stats.ct_drift = stats.ct_drift + 1
                                    log(string.format(
                                        "[BeltRestoration] CT-DRIFT %s at %s line %d k %d: placed ct %d, physical ct %d",
                                        it.stack.name, loc(entity), m.li, kphys, best.slot.ct, it.stack.count))
                                end
                                local src = best.slot.src
                                if src then
                                    local se = entity_map[src.id]
                                    if se and se.valid and se == entity and src.li == m.li then
                                        stats.same_line = stats.same_line + 1
                                        if src.k then
                                            local dk = math.abs(kphys - src.k)
                                            dk_sum = dk_sum + dk
                                            dk_n = dk_n + 1
                                            if dk > dk_max then dk_max = dk end
                                        end
                                    else
                                        stats.moved_line = stats.moved_line + 1
                                        if moved_logged < 5 then
                                            moved_logged = moved_logged + 1
                                            log(string.format(
                                                "[BeltRestoration] MOVED-LINE %s: captured entity %s line %d k %s -> placed %s line %d k %d",
                                                it.stack.name, tostring(src.id), src.li, tostring(src.k),
                                                loc(entity), m.li, best.k))
                                        end
                                    end
                                else
                                    stats.no_src = stats.no_src + 1
                                end
                            elseif global_before.by_id[uid] then
                                stats.preexisting = stats.preexisting + 1
                            else
                                stats.born = stats.born + 1
                                born_by_key[key] = (born_by_key[key] or 0) + it.stack.count
                                if born_logged < 30 then
                                    born_logged = born_logged + 1
                                    log(string.format(
                                        "[BeltRestoration] BORN-AT-DEST %s x%d at %s line %d linepos %.3f (k %d) — no placement within %d/256 matches it",
                                        it.stack.name, it.stack.count, loc(entity),
                                        m.li, it.position or -1, kphys, tol))
                                end
                            end
                        end
                    end
                end
            end
        end
        for _, p in ipairs(ledger) do
            if not p.hit then
                stats.vanished = stats.vanished + 1
                local key = item_key(p.slot.n, p.slot.q)
                van_by_key[key] = (van_by_key[key] or 0) + p.slot.ct
                if van_logged < 30 and p.e.valid then
                    van_logged = van_logged + 1
                    log(string.format(
                        "[BeltRestoration] VANISHED %s x%d: placed at %s line %d k %d, nothing physical within tolerance",
                        p.slot.n, p.slot.ct, loc(p.e), p.li, p.k))
                end
            end
        end
        for key, n in pairs(born_by_key) do
            log(string.format("[BeltRestoration] BORN-BY-KEY %q: %d items with no matching placement", key, n))
        end
        for key, n in pairs(van_by_key) do
            log(string.format("[BeltRestoration] VANISHED-BY-KEY %q: %d placed items with no physical match", key, n))
        end
        for i, slot in ipairs(unplaced_list) do
            if i > 10 then break end
            log(string.format("[BeltRestoration] UNPLACED %s x%d%s", slot.n, slot.ct,
                slot.src and string.format(" (captured from entity %s line %d k %s)",
                    tostring(slot.src.id), slot.src.li, tostring(slot.src.k)) or ""))
        end
        log(string.format(
            "[BeltRestoration] RECON: physical %d | traced %d (same-line %d, moved-line %d, no-src %d) | preexisting %d | BORN %d | VANISHED %d | ct-drift %d | aliased %d | unplaced-slots %d | source-pos-offset avg %.1f max %d (n=%d)",
            stats.phys, stats.traced, stats.same_line, stats.moved_line, stats.no_src,
            stats.preexisting, stats.born, stats.vanished, stats.ct_drift, stats.aliased,
            #unplaced_list, dk_n > 0 and dk_sum / dk_n or 0, dk_max, dk_n))
    end
    return placed, unplaced, anomalies
end

return BeltRestoration
