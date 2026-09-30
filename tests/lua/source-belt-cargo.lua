-- Staggered source belt capture: every item is read and cleared in the same callback, drifted
-- items are swept once, a cleared item that reappears stops the export, and the captured
-- cargo goes back onto the same belts and lanes when the transfer does not complete.
local root = "docker/seed-data/external_plugins/surface_export/module/"
local function noop() end
local logs = {}
local modules = {}
local env = setmetatable({storage = {}, game = {tick = 500}, log = function(m) logs[#logs + 1] = m end,
    prototypes = {item = {["iron-plate"] = {}, ["copper-plate"] = {}, pistol = {}}, quality = {normal = {}, rare = {}}}},
    {__index = _G})
env.require = function(path)
    local name = path:match("^modules/surface_export/(.*)$") or path
    if modules[name] then return modules[name] end
    modules[name] = assert(loadfile(root .. name .. ".lua", "t", env))()
    return modules[name]
end
modules["core/deserializer"] = {restore_item_properties = noop}
modules["utils/game-utils"] = {QUALITY_NORMAL = "normal"}
modules["utils/util"] = {QUALITY_NORMAL = "normal", pcall_warn = function(_, fn) assert(pcall(fn)) end,
    make_quality_key = function(n, q) return n .. "/" .. q end}
modules["utils/version-compat"] = {belt_force_insert_at = function(line, position, stack, count)
    line.force_insert_at(position, stack, count)
end}
modules["validators/cargo-counter"] = {count_entity_items = function(entity, subject)
    assert(subject == "belts", "the restore census must read belt lines only")
    local totals = {}
    for li = 1, entity.get_max_transport_line_index() do
        for _, it in ipairs(entity.get_transport_line(li).get_detailed_contents()) do
            local key = it.stack.name .. "/" .. it.stack.quality.name
            totals[key] = (totals[key] or 0) + it.stack.count
        end
    end
    return totals
end}
modules["export_scanners/inventory-scanner"] = {
    new_item_state_cache = function() return {} end,
    release_item_state_cache = noop,
    capture_item_state = function(stack) if stack.name == "pistol" then return {health = 0.5} end return nil end,
}
local census_records = {}
modules["export_scanners/source-cargo-integrity"] = {record = function(acc, entity, entity_data)
    local physical = 0
    for li = 1, entity.get_max_transport_line_index() do
        for _, it in ipairs(entity.get_transport_line(li).get_detailed_contents()) do physical = physical + it.stack.count end
    end
    local serialized = 0
    for _, line_data in ipairs(entity_data.specific_data.items) do
        for _, item in ipairs(line_data.items) do serialized = serialized + item.count end
    end
    census_records[#census_records + 1] = {id = entity_data.entity_id, physical = physical, serialized = serialized}
    acc.physical = (acc.physical or 0) + physical
    acc.serialized = (acc.serialized or 0) + serialized
end}
local cargo = env.require("modules/surface_export/core/source-belt-cargo")

local next_uid = 1000
local function line(internal)
    local self = {internal = internal, items = {}, line_length = 1}
    self.line_equals = function(other) return other.internal == internal end
    self.get_detailed_contents = function()
        local rows = {}
        for _, it in ipairs(self.items) do
            rows[#rows + 1] = {unique_id = it.uid, position = it.pos,
                stack = {valid_for_read = true, name = it.name, count = it.count, quality = {name = it.quality}}}
        end
        return rows
    end
    self.clear = function() self.items = {} end
    self.force_insert_at = function(position, stack, count)
        next_uid = next_uid + 1
        self.items[#self.items + 1] = {uid = next_uid, pos = position, name = stack.name, count = count, quality = stack.quality}
    end
    self.seed = function(name, count, quality, pos)
        next_uid = next_uid + 1
        self.items[#self.items + 1] = {uid = next_uid, pos = pos or 0.5, name = name, count = count or 1, quality = quality or "normal"}
        return next_uid
    end
    return self
end
local entities_by_unit = {}
env.game.get_entity_by_unit_number = function(unit) return entities_by_unit[unit] end
local function belt(unit, lanes, kind)
    local lines = {}
    for li, internal in ipairs(lanes) do lines[li] = line(internal) end
    local self = {valid = true, unit_number = unit, name = kind or "transport-belt", type = kind or "transport-belt",
        surface_index = 1, position = {x = unit, y = 0}, belt_neighbours = {inputs = {}, outputs = {}}, lines = lines,
        prototype = {belt_speed = 1 / 256}}
    self.get_max_transport_line_index = function() return #lines end
    self.get_transport_line = function(li) return lines[li] end
    entities_by_unit[unit] = self
    return self
end
local function feed(from, to)
    from.belt_neighbours.outputs[#from.belt_neighbours.outputs + 1] = to
    to.belt_neighbours.inputs[#to.belt_neighbours.inputs + 1] = from
end
local function drift(from, to, li)
    local moving = table.remove(from.lines[li].items)
    if moving then moving.pos = 0.05; table.insert(to.lines[li].items, 1, moving) end
    return moving
end
local function job_for(belts)
    local job = {job_id = "job-1", platform_uid = "uid:1", census = {}, export_data = {entities = {}}, belt_entities = {}}
    for i, b in ipairs(belts) do
        job.export_data.entities[i] = {entity_id = "e" .. b.unit_number, name = b.name}
        job.belt_entities[i] = b
    end
    return job
end
local function totals(belts)
    local by_key, stacks = {}, 0
    for _, b in ipairs(belts) do
        for _, l in ipairs(b.lines) do
            for _, it in ipairs(l.items) do
                local key = l.internal .. "/" .. it.name .. "/" .. it.quality
                by_key[key] = (by_key[key] or 0) + it.count
                stacks = stacks + 1
            end
        end
    end
    return by_key, stacks
end
local function payload_totals(job)
    local by_key, slots = {}, 0
    for i, entity_data in ipairs(job.export_data.entities) do
        for _, line_data in ipairs((entity_data.specific_data or {}).items or {}) do
            for _, item in ipairs(line_data.items) do
                local key = job.belt_entities[i].unit_number .. "/" .. line_data.line .. "/" .. item.name .. "/" .. item.quality
                by_key[key] = (by_key[key] or 0) + item.count
            end
        end
    end
    for _, g in ipairs(job.export_data.belt_side_groups) do slots = slots + #g.slots end
    return by_key, slots
end
local function same(a, b)
    for k, v in pairs(a) do if b[k] ~= v then return false, k end end
    for k, v in pairs(b) do if a[k] ~= v then return false, k end end
    return true
end

do
    census_records = {}
    local a, b, c = belt(1, {"loop-1", "loop-2"}), belt(2, {"loop-1", "loop-2"}), belt(3, {"loop-1", "loop-2"})
    feed(a, b) feed(b, c) feed(c, a)
    for _, x in ipairs({a, b, c}) do
        x.lines[1].seed("iron-plate", 1, "normal", 0.2) x.lines[1].seed("copper-plate", 1, "rare", 0.7)
        x.lines[2].seed("pistol", 1, "normal", 0.5)
    end
    local seeded = totals({a, b, c})
    local job = job_for({a, b, c})
    local lock = {}
    local state = cargo.begin(job, lock)
    assert(#state.units == 3 and #state.groups == 2 and lock.cleared_belts and lock.cleared_belts.groups == state.groups,
        "begin must fix the partition and register the live groups on the lock before any clearing")
    assert(not cargo.step(job, 1), "one belt per callback: not done after the first")
    assert(#a.lines[1].items == 0 and #a.lines[2].items == 0 and #b.lines[1].items == 2, "the captured belt is cleared, the others untouched")
    assert(#census_records == 1 and census_records[1].physical == 3 and census_records[1].serialized == 3, "the census reads the belt before it is cleared")
    assert(drift(c, a, 1), "an item drifts from the uncaptured belt onto the cleared one between callbacks")
    assert(not cargo.step(job, 1) and not cargo.step(job, 1), "two more single-belt callbacks")
    assert(state.sweeping and not state.done, "after the last belt the sweep is pending")
    drift(c, a, 2)
    assert(cargo.step(job, 1), "the sweep finishes the capture")
    local stats = cargo.finish(job, lock)
    assert(stats.sweep_stacks == 1 and stats.stacks == 9 and stats.callbacks == 4, "9 stacks captured, 1 by the sweep, over 4 callbacks: " .. stats.stacks .. "/" .. stats.sweep_stacks .. "/" .. stats.callbacks)
    for _, x in ipairs({a, b, c}) do for li = 1, 2 do assert(#x.lines[li].items == 0, "every line is empty after the sweep") end end
    local by_key, slots = payload_totals(job)
    assert(slots == 9 and #job.export_data.belt_side_groups == 2, "every stack is one slot in its lane group")
    local captured_total, seeded_total = 0, 0
    for _, v in pairs(by_key) do captured_total = captured_total + v end
    for _, v in pairs(seeded) do seeded_total = seeded_total + v end
    assert(captured_total == seeded_total, "captured quantity equals seeded quantity")
    assert(job.census.physical == 9 and job.census.serialized == 9, "census totals match on both sides")
    assert(lock.cleared_belts.groups == job.export_data.belt_side_groups and lock.cleared_belts.group_parent == nil
        and lock.cleared_belts.complete, "the lock keeps the finished groups for a rollback")
    logs = {}
    local ok, placed = cargo.restore(lock, "Ship")
    assert(ok, "restore refused: " .. tostring(placed))
    assert(placed == 9 and lock.cleared_belts == nil, "restore puts every captured item back and clears the record")
    assert(logs[#logs]:find("matches the capture exactly", 1, true), "a finished capture's restore reports its whole-belt census")
    local restored = totals({a, b, c})
    local equal, key = same(seeded, restored)
    assert(equal, "restored cargo differs from the seeded cargo per lane, item and quality at " .. tostring(key))
    assert(#a.lines[1].items == 3 and #c.lines[1].items == 1, "the drifted item goes back where it was captured, on the same lane")
    print("PASS a loop is captured one belt per callback, the drifted item is swept once, and the cargo goes back onto the same lanes")
end

do
    census_records = {}
    local a, b = belt(11, {"pair-1", "pair-2"}), belt(12, {"pair-1", "pair-2"})
    feed(a, b)
    local uid = a.lines[1].seed("iron-plate")
    b.lines[1].seed("iron-plate")
    local job = job_for({a, b})
    cargo.begin(job, {})
    assert(not cargo.step(job, 1))
    b.lines[1].items[#b.lines[1].items + 1] = {uid = uid, pos = 0.9, name = "iron-plate", count = 1, quality = "normal"}
    local ok, err = pcall(cargo.step, job, 1)
    assert(not ok and tostring(err):find("contract violated", 1, true) and tostring(err):find(tostring(uid), 1, true),
        "a cleared item that reappears must stop the capture: " .. tostring(err))
    print("PASS a cleared item that turns up again stops the export instead of being captured twice")
end

do
    census_records = {}
    local belts = {}
    for i = 1, 5 do belts[i] = belt(20 + i, {"b" .. i .. "-1", "b" .. i .. "-2"}); belts[i].lines[1].seed("iron-plate") end
    local job = job_for(belts)
    local state = cargo.begin(job, {})
    local steps = 0
    while not cargo.step(job, 2) do steps = steps + 1 end
    assert(steps == 3 and state.callbacks == 4, "five belts at two per callback take three callbacks plus the sweep")
    assert(#census_records == 5, "the sweep records no census for belts that stayed empty")
    print("PASS the budget bounds each callback and the sweep costs one more")
end

do
    census_records = {}
    local a, d = belt(31, {"far-1", "far-2"}), belt(32, {"far-1", "far-2"})
    local shared = a.lines[1].seed("copper-plate", 1, "rare")
    d.lines[1].items[1] = {uid = shared, pos = 0.01, name = "copper-plate", count = 1, quality = "rare"}
    d.lines[2].seed("iron-plate")
    local job = job_for({a, d})
    local state = cargo.begin(job, {})
    assert(#state.groups == 4, "belts without an adjacency start in separate groups")
    assert(cargo.step(job, 10) or cargo.step(job, 10))
    local stats = cargo.finish(job, {})
    assert(stats.stacks == 2 and stats.groups == 3 and state.merged == 1, "an item seen on two groups' lines in one callback merges them and is captured once")
    print("PASS a straddling item merges its two groups instead of being captured twice")
end

do
    census_records = {}
    local a, b = belt(41, {"r-1", "r-2"}), belt(42, {"r-1", "r-2"})
    feed(a, b)
    a.lines[1].seed("iron-plate", 2) b.lines[2].seed("pistol")
    local job = job_for({a, b})
    local lock = {}
    cargo.begin(job, lock)
    assert(not cargo.step(job, 1), "one belt captured, the lock now covers cleared cargo")
    logs = {}
    local ok, placed = cargo.restore(lock, "Ship")
    assert(ok and placed == 2 and #a.lines[1].items == 1 and a.lines[1].items[1].count == 2 and #b.lines[2].items == 1,
        "a rollback in the middle of the capture puts back what was cleared and leaves the rest alone")
    assert(logs[#logs]:find("still in progress", 1, true), "a mid-capture restore must not claim a whole-belt census")
    cargo.begin(job_for({a, b}), lock)
    entities_by_unit[42] = nil
    local refused, why = cargo.restore(lock, "Ship")
    assert(not refused and tostring(why):find("no longer exist", 1, true) and lock.cleared_belts, "a missing belt refuses the restore and keeps the record")
    entities_by_unit[42] = b
    local job2 = job_for({a, b})
    local lock2 = {}
    cargo.begin(job2, lock2)
    while not cargo.step(job2, 10) do end
    cargo.finish(job2, lock2)
    env.prototypes.item["pistol"] = nil
    local rejected, reason = cargo.restore(lock2, "Ship")
    assert(not rejected and tostring(reason):find("no prototype", 1, true) and lock2.cleared_belts and #a.lines[1].items == 0,
        "an item without a prototype refuses the restore before placing anything and keeps the record")
    env.prototypes.item["pistol"] = {}
    b.lines[2].force_insert_at = noop
    local failed, why = cargo.restore(lock2, "Ship")
    assert(not failed and tostring(why):find("mismatched", 1, true) and lock2.cleared_belts.attempt and lock2.cleared_belts.attempt.placed == 3,
        "a placement the belt did not take is reported and remembered: " .. tostring(why))
    local again, again_why = cargo.restore(lock2, "Ship")
    assert(not again and tostring(again_why):find("earlier restore attempt placed 3", 1, true) and #a.lines[1].items == 1,
        "a second attempt after a failed one is refused so nothing is placed twice: " .. tostring(again_why))
    print("PASS a rollback mid-capture restores only the cleared cargo; a missing belt, an unknown item or a failed placement keeps the protection and is never retried blindly")
end

do
    local calls = {}
    local restore_result = true
    local force = {name = "player", platforms = {}, set_surface_hidden = noop}
    local surface = {valid = true, index = 70, find_entities_filtered = function() calls[#calls + 1] = "unfreeze"; return {} end}
    force.platforms[7] = {valid = true, index = 7, name = "Ship", surface = surface, hub = {valid = true, unit_number = 1}, uid = "uid:7"}
    local lock_env = setmetatable({storage = {source_recovery_ready = true, locked_platforms = {}}, log = noop,
        game = {tick = 900, forces = {player = force}}}, {__index = _G})
    lock_env.require = function(name)
        if name:find("game-utils", 1, true) then return {ACTIVATABLE_ENTITY_TYPES = {}} end
        if name:find("platform-schedule", 1, true) then return {apply = function() return true end} end
        if name:find("latch_rearm", 1, true) then return {pending_on_surface = function() return false end} end
        if name:find("platform-identity", 1, true) then return function(p) return p.uid end end
        if name:find("passenger-transit", 1, true) then return {transfer_released = noop} end
        if name:find("source-belt-cargo", 1, true) then
            return {restore = function(lock_data, label)
                calls[#calls + 1] = "restore:" .. tostring(label)
                if restore_result then lock_data.cleared_belts = nil return true, 3 end
                return false, "3 item(s) unplaced"
            end}
        end
        error(name)
    end
    local surface_lock = assert(loadfile(root .. "utils/surface-lock.lua", "t", lock_env))()
    local function lock(with_cargo)
        lock_env.storage.locked_platforms[7] = {kind = "transfer", transfer_job_id = "job-1", phase = "pre_commit",
            platform_name = "Ship", platform_index = 7, force_name = "player", surface_index = 70, platform_uid = "uid:7",
            frozen_states = {[1] = true}, original_hidden = false, cleared_belts = with_cargo and {groups = {}} or nil}
    end
    lock(true)
    assert(surface_lock.unlock_platform(7, nil, nil, nil, "job-1"), "the transfer unlock must succeed after the cargo is back")
    assert(calls[1] == "restore:Ship" and calls[2] == "unfreeze" and lock_env.storage.locked_platforms[7] == nil,
        "captured cargo goes back before the machines are unfrozen: " .. table.concat(calls, ","))
    calls = {}
    restore_result = false
    lock(true)
    local ok, err = surface_lock.unlock_platform(7, nil, nil, nil, "job-1")
    assert(not ok and tostring(err):find("belt cargo could not be put back", 1, true) and lock_env.storage.locked_platforms[7]
        and lock_env.storage.locked_platforms[7].cleared_belts and #calls == 1,
        "a refused restore keeps the lock, the record and the frozen machines: " .. tostring(err))
    calls = {}
    restore_result = true
    lock(false)
    assert(surface_lock.unlock_platform(7, nil, nil, nil, "job-1") and calls[1] == "unfreeze" and #calls == 1,
        "an unlock without cleared cargo does not call the restore")
    print("PASS the source unlock puts captured belt cargo back before unfreezing and keeps the protection when it cannot")
end
