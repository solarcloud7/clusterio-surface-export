-- Staggered source belt capture: every item is read and cleared in the same callback, drifted
-- items are swept once, a cleared item that reappears stops the export, the capture only runs
-- under its own transfer lock, and the captured cargo goes back onto the same belts and lanes
-- when the transfer does not complete.
local root = "docker/seed-data/external_plugins/surface_export/module/"
local function noop() end
local logs = {}
local modules = {}
local env = setmetatable({storage = {locked_platforms = {}, async_jobs = {}}, game = {tick = 500}, log = function(m) logs[#logs + 1] = m end,
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
-- Belts have no get-by-unit-number flag, so game.get_entity_by_unit_number returns nil for them;
-- the restore must find them on the platform surface.
local entities_by_unit = {}
env.game.get_entity_by_unit_number = function() return nil end
local ship_surface = {valid = true, index = 70, find_entities_filtered = function(filter)
    assert(type(filter.type) == "table", "the restore must scan belt types on the platform surface")
    local out = {}
    for _, e in pairs(entities_by_unit) do if e.valid then out[#out + 1] = e end end
    return out
end}
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
local job_counter = 0
-- Every job owns a transfer lock on its platform index, as ExportPipeline.queue arranges before any capture.
local function job_for(belts, index)
    job_counter = job_counter + 1
    index = index or job_counter
    local job = {job_id = "job-" .. job_counter, platform_index = index, platform_uid = "uid:" .. index, census = {},
        export_data = {entities = {}}, belt_entities = {}}
    for i, b in ipairs(belts) do
        job.export_data.entities[i] = {entity_id = "e" .. b.unit_number, name = b.name}
        job.belt_entities[i] = b
    end
    env.storage.locked_platforms[index] = {kind = "transfer", transfer_job_id = job.job_id, platform_name = "Ship"}
    env.storage.async_jobs[job.job_id] = job
    return job, env.storage.locked_platforms[index]
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
local function run_to_end(job, budget)
    while not cargo.step(job, budget or 10) do end
    return cargo.finish(job)
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
    local job, lock = job_for({a, b, c})
    local state = cargo.begin(job)
    assert(#state.units == 3 and #state.groups == 2 and lock.cleared_belts and lock.cleared_belts.groups == state.groups
        and lock.cleared_belts.job_id == job.job_id, "begin must fix the partition and register the live groups on the owning lock before any clearing")
    assert(cargo.capture_active(lock.cleared_belts), "a running capture is active")
    assert(not cargo.step(job, 1), "one belt per callback: not done after the first")
    assert(#a.lines[1].items == 0 and #a.lines[2].items == 0 and #b.lines[1].items == 2, "the captured belt is cleared, the others untouched")
    assert(#census_records == 1 and census_records[1].physical == 3 and census_records[1].serialized == 3, "the census reads the belt before it is cleared")
    assert(drift(c, a, 1), "an item drifts from the uncaptured belt onto the cleared one between callbacks")
    assert(not cargo.step(job, 1) and not cargo.step(job, 1), "two more single-belt callbacks")
    assert(state.sweeping and not state.done, "after the last belt the sweep is pending")
    drift(c, a, 2)
    assert(cargo.step(job, 1), "the sweep finishes the capture")
    local stats = cargo.finish(job)
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
    assert(not cargo.capture_active(lock.cleared_belts), "a finished capture is no longer active")
    logs = {}
    local ok, placed = cargo.restore(lock, "Ship", ship_surface)
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
    local job, lock = job_for({a, b})
    cargo.begin(job)
    assert(not cargo.step(job, 1))
    b.lines[1].items[#b.lines[1].items + 1] = {uid = uid, pos = 0.9, name = "iron-plate", count = 1, quality = "normal"}
    local ok, err = pcall(cargo.step, job, 1)
    assert(not ok and tostring(err):find("contract violated", 1, true) and tostring(err):find(tostring(uid), 1, true),
        "a cleared item that reappears must stop the capture: " .. tostring(err))
    assert(#b.lines[1].items == 2, "the belt with the reappeared item is left untouched")
    assert(lock.cleared_belts.pinned and lock.cleared_belts.pinned.reason:find("contract violated", 1, true), "the record is pinned")
    job.completion_interrupted = {error = tostring(err)}
    local refused, why = cargo.restore(lock, "Ship", ship_surface)
    assert(not refused and tostring(why):find("pinned", 1, true) and #a.lines[1].items == 0,
        "a pinned record is never placed back on its own: " .. tostring(why))
    assert(cargo.describe(lock.cleared_belts):find("pinned: belt cargo contract violated", 1, true), cargo.describe(lock.cleared_belts))
    local abandoned, summary = cargo.override(lock, "abandon", "Ship", ship_surface)
    assert(abandoned and lock.cleared_belts == nil and tostring(summary):find("1 stack(s) / 1 item(s)", 1, true),
        "abandon drops the record and says what it held: " .. tostring(summary))
    print("PASS a cleared item that turns up again stops the export, pins the record, and only an operator can abandon it")
end

do
    census_records = {}
    local a = belt(13, {"throw-1", "throw-2"})
    a.lines[1].seed("iron-plate") a.lines[2].seed("copper-plate")
    a.lines[2].clear = function() error("engine refused the clear") end
    local job, lock = job_for({a})
    cargo.begin(job)
    local ok, err = pcall(cargo.step, job, 1)
    assert(not ok and tostring(err):find("clearing belt", 1, true) and lock.cleared_belts.pinned, "a clear that throws pins the record: " .. tostring(err))
    assert(#a.lines[1].items == 0 and #a.lines[2].items == 1 and #lock.cleared_belts.groups[1].slots + #lock.cleared_belts.groups[2].slots == 2,
        "the record keeps what was read; the belt keeps what was not cleared")
    print("PASS a belt that cannot be cleared after its cargo was recorded pins the record instead of guessing")
end

do
    census_records = {}
    local belts = {}
    for i = 1, 5 do belts[i] = belt(20 + i, {"b" .. i .. "-1", "b" .. i .. "-2"}); belts[i].lines[1].seed("iron-plate") end
    local job = job_for(belts)
    local state = cargo.begin(job)
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
    local state = cargo.begin(job)
    assert(#state.groups == 4, "belts without an adjacency start in separate groups")
    local stats = run_to_end(job)
    assert(stats.stacks == 2 and stats.groups == 3 and state.merged == 1, "an item seen on two groups' lines in one callback merges them and is captured once")
    print("PASS a straddling item merges its two groups instead of being captured twice")
end

do
    local a, b = belt(33, {"own-1", "own-2"}), belt(34, {"own-1", "own-2"})
    a.lines[1].seed("iron-plate") b.lines[1].seed("iron-plate")
    local job, lock = job_for({a, b})
    lock.transfer_job_id = "someone-else"
    local ok, err = pcall(cargo.begin, job)
    assert(not ok and tostring(err):find("not held by this job", 1, true), "begin refuses without the job's own transfer lock: " .. tostring(err))
    lock.transfer_job_id = job.job_id
    lock.cleared_belts = {job_id = "someone-else", groups = {}}
    ok, err = pcall(cargo.begin, job)
    assert(not ok and tostring(err):find("already carries", 1, true), "begin refuses to overwrite another job's record: " .. tostring(err))
    lock.cleared_belts = nil
    cargo.begin(job)
    env.storage.locked_platforms[job.platform_index] = nil
    ok, err = pcall(cargo.step, job, 1)
    assert(not ok and tostring(err):find("no longer held", 1, true) and #a.lines[1].items == 1,
        "a step after the lock went away stops before clearing anything: " .. tostring(err))
    env.storage.locked_platforms[job.platform_index] = lock
    lock.cleared_belts = {job_id = job.job_id, groups = {}}
    ok, err = pcall(cargo.step, job, 1)
    assert(not ok and tostring(err):find("no longer carries this job's cleared-cargo record", 1, true) and #a.lines[1].items == 1,
        "a step after the record was replaced stops before clearing anything: " .. tostring(err))
    lock.cleared_belts = nil
    local job2, lock2 = job_for({a, b})
    cargo.begin(job2)
    assert(not cargo.step(job2, 1))
    lock2.cleared_belts = nil
    ok, err = pcall(cargo.finish, job2)
    assert(not ok and tostring(err):find("no longer carries", 1, true), "finish refuses when the record is gone: " .. tostring(err))
    print("PASS the capture only runs under its own transfer lock and its own record")
end

do
    census_records = {}
    local a, b = belt(41, {"r-1", "r-2"}), belt(42, {"r-1", "r-2"})
    feed(a, b)
    a.lines[1].seed("iron-plate", 2) b.lines[2].seed("pistol")
    local job, lock = job_for({a, b})
    cargo.begin(job)
    assert(not cargo.step(job, 1), "one belt captured, the lock now covers cleared cargo")
    job.completion_interrupted = {error = "test"}
    logs = {}
    local ok, placed = cargo.restore(lock, "Ship", ship_surface)
    assert(ok and placed == 2 and #a.lines[1].items == 1 and a.lines[1].items[1].count == 2 and #b.lines[2].items == 1,
        "a rollback in the middle of the capture puts back what was cleared and leaves the rest alone")
    assert(logs[#logs]:find("still in progress", 1, true), "a mid-capture restore must not claim a whole-belt census")
    local job2, lock2 = job_for({a, b})
    cargo.begin(job2)
    run_to_end(job2)
    entities_by_unit[42] = nil
    local refused, why = cargo.restore(lock2, "Ship", ship_surface)
    assert(not refused and tostring(why):find("no longer on the platform", 1, true) and tostring(why):find("1 stack(s) / 1 item(s)", 1, true)
        and lock2.cleared_belts and #a.lines[1].items == 0, "a missing belt refuses the restore, says what it carried and keeps the record")
    local elsewhere, elsewhere_why = cargo.restore(lock2, "Ship", {valid = false})
    assert(not elsewhere and tostring(elsewhere_why):find("surface is unavailable", 1, true) and lock2.cleared_belts, "no surface, no restore")
    logs = {}
    local present, placed_present = cargo.override(lock2, "restore-present", "Ship", ship_surface)
    assert(present and placed_present == 2 and lock2.cleared_belts == nil and #a.lines[1].items == 1,
        "restore-present places the cargo of the belts that still exist and clears the record: " .. tostring(placed_present))
    assert(logs[#logs]:find("1 belt(s) were gone, so 1 stack(s) / 1 item(s)", 1, true) and logs[#logs]:find("matches the capture exactly", 1, true),
        "the lost cargo is reported with the exact census of the rest: " .. tostring(logs[#logs]))
    entities_by_unit[42] = b
    b.lines[2].seed("pistol")
    local job3, lock3 = job_for({a, b})
    cargo.begin(job3)
    run_to_end(job3)
    env.prototypes.item["pistol"] = nil
    local rejected, reason = cargo.restore(lock3, "Ship", ship_surface)
    assert(not rejected and tostring(reason):find("no prototype", 1, true) and lock3.cleared_belts and #a.lines[1].items == 0,
        "an item without a prototype refuses the restore before placing anything and keeps the record")
    env.prototypes.item["pistol"] = {}
    b.lines[2].force_insert_at = noop
    local failed, why2 = cargo.restore(lock3, "Ship", ship_surface)
    assert(not failed and tostring(why2):find("mismatched", 1, true) and lock3.cleared_belts.attempt and lock3.cleared_belts.attempt.placed == 3,
        "a placement the belt did not take is reported and remembered: " .. tostring(why2))
    local again, again_why = cargo.restore(lock3, "Ship", ship_surface)
    assert(not again and tostring(again_why):find("earlier restore attempt placed 3", 1, true) and #a.lines[1].items == 1,
        "a second attempt after a failed one is refused so nothing is placed twice: " .. tostring(again_why))
    local retry, retry_why = cargo.override(lock3, "restore-present", "Ship", ship_surface)
    assert(not retry and tostring(retry_why):find("already ran", 1, true) and lock3.cleared_belts and #a.lines[1].items == 1,
        "restore-present after any earlier attempt is refused, nothing is placed twice: " .. tostring(retry_why))
    lock3.cleared_belts.attempt = {tick = 1, error = "threw partway"}
    retry, retry_why = cargo.override(lock3, "restore-present", "Ship", ship_surface)
    assert(not retry and tostring(retry_why):find("already ran", 1, true) and #a.lines[1].items == 1,
        "an attempt that threw before it could count placements is refused too: " .. tostring(retry_why))
    lock3.phase = "committed"
    local committed, committed_why = cargo.override(lock3, "abandon", "Ship", ship_surface)
    assert(not committed and tostring(committed_why):find("already committed", 1, true) and lock3.cleared_belts, "a committed source keeps its record untouched: " .. tostring(committed_why))
    lock3.phase = nil
    assert(cargo.override(lock3, "abandon", "Ship", ship_surface) and lock3.cleared_belts == nil, "abandon is the way out after a partial placement")
    local bogus, bogus_why = cargo.override({cleared_belts = {groups = {}}}, "explode", "Ship", ship_surface)
    assert(not bogus and tostring(bogus_why):find("unknown action", 1, true))
    local x = belt(43, {"pin-1", "pin-2"})
    x.lines[1].seed("iron-plate") x.lines[2].seed("iron-plate")
    x.lines[2].clear = function() error("engine refused the clear") end
    local job4, lock4 = job_for({x})
    cargo.begin(job4)
    assert(not pcall(cargo.step, job4, 1) and lock4.cleared_belts.pinned, "the clear failure pins the record")
    job4.completion_interrupted = {error = "test"}
    local pinned_retry, pinned_why = cargo.override(lock4, "restore-present", "Ship", ship_surface)
    assert(not pinned_retry and tostring(pinned_why):find("pinned", 1, true) and #x.lines[1].items == 0 and #x.lines[2].items == 1,
        "restore-present never places a pinned record, whose items may still be on the belts: " .. tostring(pinned_why))
    assert(cargo.override(lock4, "abandon", "Ship", ship_surface) and lock4.cleared_belts == nil, "abandon releases a pinned record")
    print("PASS a rollback mid-capture restores only the cleared cargo; missing belts, unknown items and failed placements keep the protection until an operator decides")
end

do
    census_records = {}
    local a = belt(51, {"c-1", "c-2"})
    a.lines[1].seed("iron-plate", 2)
    local job, lock = job_for({a})
    cargo.begin(job)
    run_to_end(job)
    a.lines[2].seed("copper-plate", 1, "rare")
    local ok, why = cargo.restore(lock, "Ship", ship_surface)
    assert(not ok and tostring(why):find("differs from the capture", 1, true) and tostring(why):find("copper-plate/rare captured 0, on belts 1", 1, true)
        and lock.cleared_belts.attempt and lock.cleared_belts.attempt.placed == 2,
        "cargo that appeared on a captured belt after the sweep fails the whole-belt census and is remembered: " .. tostring(why))
    print("PASS a finished capture's restore refuses when the belts hold more than was captured")
end

do
    local calls = {}
    local restore_result = true
    local active = false
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
            return {restore = function(lock_data, label, restore_surface)
                assert(restore_surface == surface, "the unlock must hand the restore the verified platform surface")
                calls[#calls + 1] = "restore:" .. tostring(label)
                if restore_result then lock_data.cleared_belts = nil return true, 3 end
                return false, "3 item(s) unplaced"
            end, capture_active = function() return active end, describe = function() return "described" end}
        end
        error(name)
    end
    local surface_lock = assert(loadfile(root .. "utils/surface-lock.lua", "t", lock_env))()
    local function lock(with_cargo)
        lock_env.storage.locked_platforms[7] = {kind = "transfer", transfer_job_id = "job-1", phase = "pre_commit",
            platform_name = "Ship", platform_index = 7, force_name = "player", surface_index = 70, platform_uid = "uid:7",
            frozen_states = {[1] = true}, original_hidden = false, cleared_belts = with_cargo and {job_id = "job-1", groups = {}} or nil}
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
    active = true
    lock(true)
    ok, err = surface_lock.unlock_platform(7, nil, nil, nil, "job-1")
    assert(not ok and tostring(err):find("still capturing belt cargo", 1, true) and #calls == 0 and lock_env.storage.locked_platforms[7].cleared_belts,
        "an unlock while the capture is still running is refused before anything is restored or unfrozen: " .. tostring(err))
    active = false
    calls = {}
    lock(true)
    local owns = surface_lock.destination_hold_owns_surface
    surface_lock.destination_hold_owns_surface = function() return true, "hold-1" end
    ok, err = surface_lock.unlock_platform(7, nil, nil, nil, "job-1")
    assert(not ok and tostring(err):find("destination hold hold-1 owns this surface while captured belt cargo is recorded", 1, true)
        and lock_env.storage.locked_platforms[7] and #calls == 0, "a hold-owned surface with recorded cargo refuses the unlock: " .. tostring(err))
    surface_lock.destination_hold_owns_surface = owns
    calls = {}
    lock(false)
    assert(surface_lock.unlock_platform(7, nil, nil, nil, "job-1") and calls[1] == "unfreeze" and #calls == 1,
        "an unlock without cleared cargo does not call the restore")
    print("PASS the source unlock puts captured belt cargo back before unfreezing, waits for a running capture, and keeps the protection when it cannot")
end
