local Deserializer = require("modules/surface_export/core/deserializer")
local GameUtils = require("modules/surface_export/utils/game-utils")
local InventoryScanner = require("modules/surface_export/export_scanners/inventory-scanner")
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
                or (slot.q ~= nil and type(slot.q) ~= "string")
                or (slot.st ~= nil and type(slot.st) ~= "table") then
                return false, string.format("group %d slot %d malformed", gi, si)
            end
        end
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

local function belt_item_state(stack, cache)
    if not cache then return nil end
    local capture_ok, state = pcall(InventoryScanner.capture_item_state, stack, cache)
    if not capture_ok then
        cache.failures = (cache.failures or 0) + 1
        if cache.failures <= 5 then
            log(string.format("[BeltRestoration] item-state capture failed for %s: %s — that stack ships stateless",
                stack.name, tostring(state)))
        end
        return nil
    end
    return state
end

local function collect_side_groups(belt_pairs, cache)
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
                        st = belt_item_state(it.stack, cache),
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
    local stateful = 0
    for _, g in ipairs(groups) do
        for _, slot in ipairs(g.slots) do
            if slot.st then stateful = stateful + 1 end
        end
        out[#out + 1] = { members = g.members, slots = g.slots, item_source_positions = g.item_source_positions }
    end
    log(string.format("[BeltRestoration] Captured %d side group(s); %d slot(s) carry non-default item state",
        #out, stateful))
    return out
end

function BeltRestoration.capture_side_groups(belt_pairs)
    if not belt_pairs or #belt_pairs == 0 then return nil end
    local cache_ok, cache = pcall(InventoryScanner.new_item_state_cache)
    if not cache_ok then
        log(string.format("[BeltRestoration] item-state cache unavailable (%s) — every slot ships stateless; "
            .. "the side partition itself is unaffected", tostring(cache)))
        cache = nil
    end
    local ok, result = pcall(collect_side_groups, belt_pairs, cache)
    Util.pcall_warn("[BeltRestoration] item-state cache release", function()
        InventoryScanner.release_item_state_cache(cache)
    end)
    if not ok then error(result, 0) end
    return result
end

function BeltRestoration.export_string_keeps_identity(scratch, name, quality, count, export_string)
    if not (scratch and scratch.inventory and scratch.inventory.valid) then
        return false, "no scratch inventory"
    end
    local slot = scratch.inventory[1]
    local wanted_quality = quality or QUALITY_NORMAL
    local set_ok, set_error = pcall(function()
        slot.clear()
        slot.set_stack({ name = name, quality = wanted_quality, count = count })
    end)
    if not set_ok then return false, tostring(set_error) end
    if not slot.valid_for_read then return false, "scratch stack did not take" end

    local import_ok, import_error = pcall(function() return slot.import_stack(export_string) end)
    if not import_ok then
        Util.pcall_warn("[BeltRestoration] scratch clear", function() slot.clear() end)
        return false, tostring(import_error)
    end

    local seen = "empty"
    local keeps = false
    if slot.valid_for_read then
        local seen_quality = (slot.quality and slot.quality.name) or QUALITY_NORMAL
        seen = string.format("%s (%s) x%d", slot.name, seen_quality, slot.count)
        keeps = slot.name == name and seen_quality == wanted_quality and slot.count == count
    end
    Util.pcall_warn("[BeltRestoration] scratch clear", function() slot.clear() end)
    return keeps, seen
end

local function needs_scratch(side_groups)
    for _, g in ipairs(side_groups or {}) do
        for _, slot in ipairs((type(g) == "table" and g.slots) or {}) do
            if type(slot) == "table" and slot.st and slot.st.export_string then return true end
        end
    end
    return false
end

local function run_side_restore(side_groups, entity_map, platform_label, scratch)
    local label = tostring(platform_label or "unnamed")
    local function item_key(name, quality)
        return name .. "\0" .. (quality or QUALITY_NORMAL)
    end
    local function side_lines(g)
        local lines = {}
        for _, m in ipairs(g.members) do
            local entity = entity_map[m.id]
            if entity and entity.valid then lines[#lines + 1] = entity.get_transport_line(m.li) end
        end
        return lines
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
    local state_stats = { applied = 0, unmatched = 0, failed = 0, merge_discarded = 0, declined = 0 }
    local state_logged = 0
    local function line_ids(line)
        local ids = {}
        for _, item in ipairs(line.get_detailed_contents()) do ids[item.unique_id] = true end
        return ids
    end
    local function apply_state(line, before_ids, st, stack_def, count)
        local landed_stack, arrivals = nil, 0
        for _, item in ipairs(line.get_detailed_contents()) do
            if not before_ids[item.unique_id] then
                arrivals = arrivals + 1
                landed_stack = item.stack
            end
        end
        local readable = landed_stack and landed_stack.valid_for_read
        if arrivals ~= 1 or not readable or landed_stack.count ~= count then
            state_stats.unmatched = state_stats.unmatched + 1
            state_logged = state_logged + 1
            if state_logged <= 10 then
                log(string.format(
                    "[BeltRestoration] STATE UNMATCHED: %d new stack(s) after the write, count %s vs %d written "
                    .. "— item state not applied",
                    arrivals, readable and tostring(landed_stack.count) or "nil", count))
            end
            return
        end
        local scalars = st
        local wrote, refused = false, false
        if st.export_string then
            scalars = {}
            for key, value in pairs(st) do
                if key ~= "export_string" then scalars[key] = value end
            end
            local keeps, seen = BeltRestoration.export_string_keeps_identity(scratch, stack_def.name,
                stack_def.quality, count, st.export_string)
            if keeps then
                local ok, err = pcall(function() return landed_stack.import_stack(st.export_string) end)
                if ok then
                    wrote = true
                else
                    refused = true
                    state_logged = state_logged + 1
                    if state_logged <= 10 then
                        log(string.format("[BeltRestoration] STATE export_string WRITE FAILED for %s: %s",
                            tostring(stack_def.name), tostring(err)))
                    end
                end
            else
                state_stats.declined = state_stats.declined + 1
                state_logged = state_logged + 1
                if state_logged <= 10 then
                    log(string.format(
                        "[BeltRestoration] STATE DECLINED export_string for %s (%s) x%d: the scratch preflight read "
                        .. "%s — the live stack was not written",
                        tostring(stack_def.name), tostring(stack_def.quality or QUALITY_NORMAL), count,
                        tostring(seen)))
                end
            end
        end
        if next(scalars) ~= nil then
            local ok, err = pcall(Deserializer.restore_item_properties, landed_stack, scalars)
            if ok then
                wrote = true
            else
                refused = true
                state_logged = state_logged + 1
                if state_logged <= 10 then
                    log(string.format("[BeltRestoration] STATE WRITE FAILED for %s: %s",
                        landed_stack.valid_for_read and landed_stack.name or "?", tostring(err)))
                end
            end
        end
        if refused then
            state_stats.failed = state_stats.failed + 1
        elseif wrote then
            state_stats.applied = state_stats.applied + 1
        end
    end
    local function insert_with_state(line, k, stack_def, count, st)
        local before_ids = st and line_ids(line) or nil
        if not VersionCompat.belt_insert_at(line, k / 256, stack_def, count) then return false end
        if before_ids then apply_state(line, before_ids, st, stack_def, count) end
        return true
    end
    local side_before = {}
    local preexisting_ids = {}
    for gi, g in ipairs(side_groups) do
        local snap = snapshot(side_lines(g))
        side_before[gi] = snap
        for id in pairs(snap.by_id) do preexisting_ids[id] = true end
    end
    local expected_by_side = {}
    local placed, unplaced, anomalies = 0, 0, 0
    local ledger = {}
    local unplaced_list = {}
    local unknown_logged = 0
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
    local pending = {}
    for gi, g in ipairs(side_groups) do
        local exp = {}
        expected_by_side[gi] = exp
        local function try_insert(line, w_entity, w_li, k, slot, wanted_key)
            if not line.can_insert_at(k / 256) then return nil end
            local landed = insert_with_state(line, k,
                { name = slot.n, quality = slot.q, count = slot.ct }, slot.ct, slot.st)
            if landed then
                placed = placed + slot.ct
                exp[wanted_key] = (exp[wanted_key] or 0) + slot.ct
                ledger[#ledger + 1] = { e = w_entity, li = w_li, k = k, slot = slot, key = wanted_key }
                return true
            end
            return nil
        end
        for _, slot in ipairs(g.slots) do
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
                end
            end
            if not done then
                pending[#pending + 1] = { slot = slot, gi = gi }
            end
          end
        end
    end
    for _, entry in ipairs(pending) do
        local slot, gi = entry.slot, entry.gi
        local done = false
        local se = slot.src and entity_map[slot.src.id]
        if se and se.valid then
            local wanted_key = item_key(slot.n, slot.q)
            local partner
            for _, ledger_entry in ipairs(ledger) do
                if ledger_entry.e == se and ledger_entry.li == slot.src.li and ledger_entry.key == wanted_key then
                    partner = ledger_entry
                end
            end
            if partner then
                local function scan_place(count, st)
                    local mline = se.get_transport_line(slot.src.li)
                    local mkmin = math.floor(se.prototype.belt_speed * 256 + 0.5)
                    local mtop = math.floor(mline.line_length * 256 + 0.5)
                    for k = math.min(partner.k, mtop - mkmin), mkmin, -1 do
                        if mline.can_insert_at(k / 256)
                            and insert_with_state(mline, k,
                                { name = slot.n, quality = slot.q, count = count }, count, st) then
                            return k
                        end
                    end
                    for k = partner.k + 1, mtop - mkmin do
                        if mline.can_insert_at(k / 256)
                            and insert_with_state(mline, k,
                                { name = slot.n, quality = slot.q, count = count }, count, st) then
                            return k
                        end
                    end
                end
                local merged_ct = partner.slot.ct + slot.ct
                local merged_st = partner.slot.st
                local removed = se.get_transport_line(slot.src.li).remove_item(
                    { name = slot.n, quality = slot.q, count = partner.slot.ct })
                local landed_k = nil
                if removed == partner.slot.ct then
                    landed_k = scan_place(merged_ct, merged_st)
                end
                if landed_k then
                    placed = placed + slot.ct
                    local exp = expected_by_side[gi]
                    exp[wanted_key] = (exp[wanted_key] or 0) + slot.ct
                    partner.slot = { n = slot.n, q = slot.q, ct = merged_ct, src = partner.slot.src, st = merged_st }
                    partner.k = landed_k
                    log(string.format(
                        "[BeltRestoration] OVER-COMPRESSION MERGE: %s x%d joined the stack near entity %s line %d (now x%d) — engine packed tighter than insert_at can recreate",
                        slot.n, slot.ct, tostring(slot.src.id), slot.src.li, merged_ct))
                    if slot.st then
                        state_stats.merge_discarded = state_stats.merge_discarded + 1
                        log(string.format(
                            "[BeltRestoration] MERGE DISCARDED item state for %s x%d — one physical stack "
                            .. "carries one state, the partner's is kept",
                            slot.n, slot.ct))
                    end
                    done = true
                else
                    local putback_k = nil
                    if removed > 0 then
                        putback_k = scan_place(removed, merged_st)
                    end
                    if putback_k and removed == partner.slot.ct then
                        partner.k = putback_k
                        log(string.format(
                            "[BeltRestoration] OVER-COMPRESSION MERGE could not land for %s x%d — partner re-placed (engine-confirmed), slot stays unplaced",
                            slot.n, slot.ct))
                    else
                        log(string.format(
                            "[BeltRestoration] OVER-COMPRESSION MERGE could not land for %s x%d (removed=%d, put-back %s) — the side bracket owns the discrepancy",
                            slot.n, slot.ct, removed, putback_k and "partial" or "did not land"))
                    end
                end
            end
        end
        if not done then
            unplaced = unplaced + slot.ct
            unplaced_list[#unplaced_list + 1] = slot
        end
    end
    local physical_delta = {}
    for gi, g in ipairs(side_groups) do
        local before = side_before[gi]
        local after = snapshot(side_lines(g))
        local exp = expected_by_side[gi]
        local keys = {}
        for key in pairs(before.by_key) do keys[key] = true end
        for key in pairs(after.by_key) do keys[key] = true end
        for key in pairs(exp) do keys[key] = true end
        local side_failed = false
        for key in pairs(keys) do
            local delta = (after.by_key[key] or 0) - (before.by_key[key] or 0)
            if delta ~= 0 then physical_delta[key] = (physical_delta[key] or 0) + delta end
            if delta ~= (exp[key] or 0) then
                side_failed = true
                log(string.format("[BeltRestoration] SIDE BRACKET MISMATCH group %d %q: physical delta %d ~= placed %d",
                    gi, key, delta, exp[key] or 0))
            end
        end
        if side_failed then anomalies = anomalies + 1 end
    end
    for key, delta in pairs(physical_delta) do
        if delta == 0 then physical_delta[key] = nil end
    end
    local dbg = storage.surface_export_config and storage.surface_export_config.debug_mode
    if dbg or anomalies > 0 then
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
                            elseif preexisting_ids[uid] then
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
    if state_stats.applied + state_stats.unmatched + state_stats.failed + state_stats.merge_discarded
        + state_stats.declined > 0 then
        log(string.format(
            "[BeltRestoration] ITEM STATE %s: applied %d | unmatched %d | failed %d | merge-discarded %d "
            .. "| declined %d",
            label, state_stats.applied, state_stats.unmatched, state_stats.failed, state_stats.merge_discarded,
            state_stats.declined))
    end
    return placed, unplaced, anomalies, physical_delta, state_stats
end

function BeltRestoration.restore_side_groups(side_groups, entity_map, platform_label)
    local scratch = nil
    if needs_scratch(side_groups) then
        local scratch_ok, created = pcall(InventoryScanner.new_item_state_cache)
        if scratch_ok then
            scratch = created
        else
            log(string.format("[BeltRestoration] item-state scratch unavailable (%s) — every export_string is "
                .. "declined; placement itself is unaffected", tostring(created)))
        end
    end
    local ok, placed, unplaced, anomalies, delta, stats = pcall(run_side_restore, side_groups,
        entity_map, platform_label, scratch)
    Util.pcall_warn("[BeltRestoration] item-state scratch release", function()
        InventoryScanner.release_item_state_cache(scratch)
    end)
    if not ok then error(placed, 0) end
    return placed, unplaced, anomalies, delta, stats
end

return BeltRestoration
