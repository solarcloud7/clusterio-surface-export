-- Side-group capture must partition belt lines exactly as the pairwise line_equals
-- search did, in the same order, while comparing only lines of connected belts.
local prefix = "modules/surface_export/"
local function stub(name, value) package.preload[prefix .. name] = function() return value end end
stub("core/deserializer", {})
stub("utils/game-utils", {QUALITY_NORMAL = "normal"})
local item_state_reads, cache_releases = 0, 0
stub("export_scanners/inventory-scanner", {
    new_item_state_cache = function() return {} end,
    release_item_state_cache = function() cache_releases = cache_releases + 1 end,
    capture_item_state = function(stack)
        item_state_reads = item_state_reads + 1
        if stack.name == "pistol" then return {health = 0.5} end
        return nil
    end,
})
stub("utils/util", {pcall_warn = function(_, fn) assert(pcall(fn)) end, make_quality_key = function(n, q) return n .. "/" .. q end})
stub("utils/version-compat", {})
local logs = {}
function log(message) logs[#logs + 1] = message end
storage = {}
local restorer = dofile("docker/seed-data/external_plugins/surface_export/module/import_phases/belt_restoration.lua")

local compared = 0
local function line(internal, items)
    local self = {internal = internal, items = items or {}}
    self.line_equals = function(other) compared = compared + 1 return other.internal == internal end
    self.get_detailed_contents = function()
        local rows = {}
        for _, it in ipairs(self.items) do
            rows[#rows + 1] = {unique_id = it.uid, position = it.pos,
                stack = {valid_for_read = true, name = it.name, count = it.count or 1, quality = {name = it.quality or "normal"}}}
        end
        return rows
    end
    return self
end
local function belt(unit, lines, kind)
    local self = {valid = true, unit_number = unit, type = kind or "transport-belt", surface_index = 1,
        belt_neighbours = {inputs = {}, outputs = {}}, lines = lines}
    self.get_max_transport_line_index = function() return #lines end
    self.get_transport_line = function(li) return lines[li] end
    return self
end
local function feed(from, to, one_sided)
    if one_sided ~= "inputs" then from.belt_neighbours.outputs[#from.belt_neighbours.outputs + 1] = to end
    if one_sided ~= "outputs" then to.belt_neighbours.inputs[#to.belt_neighbours.inputs + 1] = from end
end
local function pairs_of(belts)
    local out = {}
    for _, b in ipairs(belts) do out[#out + 1] = {entity = b, id = "e" .. b.unit_number} end
    return out
end

local function oracle(belt_pairs)
    local groups = {}
    for _, bp in ipairs(belt_pairs) do
        for li = 1, bp.entity.get_max_transport_line_index() do
            local l = bp.entity.get_transport_line(li)
            local gi
            for j, g in ipairs(groups) do if l.line_equals(g.rep) then gi = j break end end
            if not gi then gi = #groups + 1 groups[gi] = {rep = l, seen = {}, members = {}, slots = {}, item_source_positions = {}} end
            local g = groups[gi]
            g.members[#g.members + 1] = {id = bp.id, li = li}
            for _, it in ipairs(l.get_detailed_contents()) do
                local uid = tostring(it.unique_id)
                if not g.seen[uid] then
                    g.seen[uid] = true
                    g.slots[#g.slots + 1] = {n = it.stack.name, q = it.stack.quality.name, ct = it.stack.count,
                        st = it.stack.name == "pistol" and {health = 0.5} or nil}
                    local s = g.item_source_positions
                    s[#s + 1] = bp.id s[#s + 1] = li s[#s + 1] = math.floor((it.position or 0) * 256 + 0.5)
                end
            end
        end
    end
    local out = {}
    for _, g in ipairs(groups) do out[#out + 1] = {members = g.members, slots = g.slots, item_source_positions = g.item_source_positions} end
    return out
end

local function dump(value, depth)
    if type(value) ~= "table" then return tostring(value) end
    local keys = {}
    for k in pairs(value) do keys[#keys + 1] = k end
    table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
    local parts = {}
    for _, k in ipairs(keys) do parts[#parts + 1] = tostring(k) .. "=" .. dump(value[k], (depth or 0) + 1) end
    return "{" .. table.concat(parts, ",") .. "}"
end
local function check(label, belts, expect_groups)
    local belt_pairs = pairs_of(belts)
    local expected = oracle(belt_pairs)
    compared = 0
    logs = {}
    local actual = restorer.capture_side_groups(belt_pairs)
    assert(dump(actual) == dump(expected), label .. ": side groups differ\n expected " .. dump(expected) .. "\n actual   " .. dump(actual))
    if expect_groups then assert(#actual == expect_groups, label .. ": " .. #actual .. " groups, expected " .. expect_groups) end
    local capture_line = logs[#logs] or ""
    assert(capture_line:find("Captured %d+ side group%(s%) from %d+ belt%(s%)"), label .. ": capture log line missing")
    return actual, compared, capture_line, table.concat(logs, "\n")
end
local function walked(capture_line) return tonumber(capture_line:match("%((%d+) walked")) end

do
    local L1, L2 = "run-lane-1", "run-lane-2"
    local run = {}
    for i = 1, 4 do run[i] = belt(10 + i, {line(L1, {{uid = 100 + i, pos = 0.5, name = "iron-plate"}}), line(L2)}) end
    for i = 1, 3 do feed(run[i], run[i + 1]) end
    local side = belt(20, {line("side-1", {{uid = 300, pos = 0.25, name = "pistol"}}), line("side-2")})
    feed(side, run[2])
    local groups, comparisons, capture_line = check("straight run with a side load", {run[1], run[2], run[3], run[4], side}, 4)
    assert(#groups[1].members == 4 and groups[1].members[4].id == "e14", "the run's lane shares one group in belt order")
    assert(#groups[1].slots == 4 and groups[1].item_source_positions[1] == "e11", "slots follow belt order")
    assert(groups[3].slots[1].st.health == 0.5, "item state travels with the slot")
    assert(comparisons < 60, "connected belts should need few comparisons, got " .. comparisons)
    assert(walked(capture_line) == 5, "every listed belt is walked once: " .. capture_line)
    print("PASS a straight run shares lanes; a side-loading belt keeps its own")
end

do
    for _, side in ipairs({"inputs", "outputs"}) do
        local L1, L2 = "half-" .. side .. "-1", "half-" .. side .. "-2"
        local a = belt(70, {line(L1, {{uid = 700, pos = 0.9, name = "iron-plate"}}), line(L2)})
        local b = belt(71, {line(L1, {{uid = 701, pos = 0.1, name = "iron-plate"}}), line(L2)})
        feed(a, b, side)
        local groups, _, capture_line = check("neighbour listed on the " .. side .. " side only", {a, b}, 2)
        assert(#groups[1].members == 2, "an adjacency reported by one side only still joins the lane")
        assert(walked(capture_line) == 2, "the one-sided adjacency must be joined by the walk itself: " .. capture_line)
    end
    print("PASS an adjacency reported by only one of the two belts still joins their lanes")
end

do
    local L1, L2 = "shared-1", "shared-2"
    local run = {}
    for i = 1, 4 do run[i] = belt(30 + i, {line(L1, {{uid = 400 + i, pos = 0.5, name = "copper-plate"}}), line(L2)}) end
    for i = 1, 3 do feed(run[i], run[i + 1]) end
    check("belt_pairs order decides group and member order", {run[4], run[2], run[3], run[1]}, 2)
    print("PASS group, member and slot order follow the belt list, not unit numbers")
end

do
    local entrance = belt(41, {line("u-tunnel-1"), line("u-top-2"), line("u-tunnel-1", {{uid = 500, pos = 0.1, name = "coal"}}), line("u-tunnel-2")}, "underground-belt")
    local exit = belt(42, {line("u-tunnel-1", {{uid = 500, pos = 0.1, name = "coal"}}), line("u-tunnel-2"), line("u-out-1"), line("u-out-2")}, "underground-belt")
    entrance.underground_belt_neighbour, exit.underground_belt_neighbour = exit, entrance
    local groups, _, capture_line = check("underground pair", {entrance, exit}, 5)
    assert(#groups[1].members == 3 and #groups[1].slots == 1, "the tunnel lane is one group across both ends, item seen once")
    assert(walked(capture_line) == 2, "the ends must be joined by the walk itself, not by the fallback: " .. capture_line)
    local lone = belt(43, {line("lone-1"), line("lone-2"), line("lone-1"), line("lone-4")}, "underground-belt")
    groups = check("lone underground end", {lone}, 3)
    assert(#groups[1].members == 2, "two lanes of one belt that are the same line share a group")
    print("PASS underground ends share their tunnel lanes, including a lane shared within one end")
end

do
    local a = belt(51, {line("bridge-1"), line("bridge-2")})
    local x = belt(52, {line("bridge-1"), line("bridge-2")})
    local c = belt(53, {line("bridge-1"), line("bridge-2")})
    feed(a, x) feed(x, c)
    local stranger = belt(54, {line("stranger-1"), line("stranger-2")})
    local far = belt(55, {line("far-1"), line("far-2")})
    feed(stranger, a) feed(far, stranger)
    local groups, _, capture_line = check("bridging belt outside the list", {a, c}, 2)
    assert(#groups[1].members == 2, "lines joined through a belt that is not in the list still share a group")
    assert(walked(capture_line) == 3, "only unlisted belts that share a lane are walked: " .. capture_line)
    print("PASS a shared lane through a belt outside the list is still one group; unrelated belts are not walked")
end

do
    local ghost = {valid = true, unit_number = 81, type = "entity-ghost", surface_index = 1}
    local entrance = belt(82, {line("g-1"), line("g-2"), line("g-3"), line("g-4")}, "underground-belt")
    entrance.underground_belt_neighbour = ghost
    local elsewhere = belt(83, {line("l-1"), line("e-2")})
    elsewhere.surface_index = 2
    local linked = belt(84, {line("l-1"), line("l-2")}, "linked-belt")
    linked.linked_belt_neighbour = elsewhere
    local dead = setmetatable({valid = false}, {__index = function(_, key) error("LuaEntity was invalid; read " .. tostring(key)) end})
    feed(dead, linked, "inputs")
    feed(linked, entrance)
    local _, _, capture_line, trace = check("ghost, invalid and off-surface partners", {entrance, linked}, 6)
    assert(walked(capture_line) == 2, "a ghost, an invalid entity or an entity on another surface is never walked: " .. capture_line)
    assert(not trace:find("partition failed", 1, true), "an invalid neighbour must be skipped, not read: " .. trace)
    print("PASS ghost, invalid and other-surface partners are skipped without failing the capture")
end

do
    local a = belt(91, {line("apart-1", {{uid = 910, pos = 0.99, name = "iron-plate"}}), line("apart-2")})
    local c = belt(92, {line("apart-1", {{uid = 910, pos = 0.01, name = "iron-plate"}}), line("apart-2")})
    item_state_reads = 0
    local groups, _, capture_line, trace = check("equal lines without an adjacency", {a, c}, 2)
    assert(#groups[1].members == 2 and #groups[1].slots == 1, "the pairwise search restores the engine's grouping")
    assert(trace:find("disagreed with the engine", 1, true) and capture_line:find("pairwise search", 1, true),
        "the disagreement and the fallback were not logged: " .. trace)
    assert(item_state_reads == 1, "the fallback must reuse the first pass's item-state reads, got " .. item_state_reads .. " reads")
    print("PASS an item seen on two groups' lines falls back to the pairwise search, reading its state once")
end

do
    local a = belt(95, {line("dup-1", {{uid = 950, pos = 0.5, name = "iron-plate"}}), line("dup-2")})
    local c = belt(96, {line("dup-3", {{uid = 950, pos = 0.5, name = "iron-plate"}}), line("dup-4")})
    logs = {}
    cache_releases = 0
    local ok, err = pcall(restorer.capture_side_groups, pairs_of({a, c}))
    assert(not ok, "an item on two lines that are not the same line must refuse the capture")
    assert(tostring(err):find("would duplicate that item", 1, true) and tostring(err):find("950", 1, true),
        "the refusal must name the item: " .. tostring(err))
    assert(table.concat(logs, "\n"):find("disagreed with the engine", 1, true), "the first pass's disagreement was not logged")
    assert(cache_releases == 1, "the item-state cache must be released after a refused capture")
    print("PASS an item still on two groups' lines in the pairwise search refuses the capture instead of duplicating it")
end

do
    local broken = belt(93, {line("broken-1"), line("broken-2")})
    broken.belt_neighbours = nil
    setmetatable(broken, {__index = function(_, key) if key == "belt_neighbours" then error("belt_neighbours is not available") end end})
    local partner = belt(94, {line("broken-1"), line("broken-2")})
    feed(partner, broken, "outputs")
    local groups, _, capture_line, trace = check("neighbour read failure", {broken, partner}, 2)
    assert(#groups[1].members == 2, "the pairwise search still groups the shared lane")
    assert(trace:find("partition failed", 1, true) and capture_line:find("pairwise search", 1, true),
        "the failure and the fallback were not logged: " .. trace)
    print("PASS a failing neighbour read falls back to the pairwise search")
end

do
    local lines = {}
    for i = 1, 8 do lines[i] = line("split-" .. i) end
    local splitter = belt(61, lines, "splitter")
    local feeder = belt(62, {line("feed-1"), line("feed-2")})
    feed(feeder, splitter)
    local linked_a = belt(63, {line("link-a-1"), line("link-a-2")}, "linked-belt")
    local linked_b = belt(64, {line("link-b-1"), line("link-b-2")}, "linked-belt")
    linked_a.linked_belt_neighbour, linked_b.linked_belt_neighbour = linked_b, linked_a
    local loader = belt(65, {line("load-1"), line("load-2")}, "loader")
    feed(splitter, loader)
    check("splitter, loader and linked belts", {splitter, feeder, linked_a, linked_b, loader}, 16)
    print("PASS distinct lanes on splitters, loaders and linked belts stay distinct")
end

do
    for seed = 1, 40 do
        math.randomseed(seed)
        local belts = {}
        local unit = 1000
        for chain = 1, math.random(1, 4) do
            local length = math.random(1, 9)
            local lane1, lane2 = "s" .. seed .. "c" .. chain .. "a", "s" .. seed .. "c" .. chain .. "b"
            local previous
            for i = 1, length do
                if math.random() < 0.3 then lane1 = lane1 .. "'" end
                if math.random() < 0.3 then lane2 = lane2 .. "'" end
                local items1, items2 = {}, {}
                if math.random() < 0.5 then items1[1] = {uid = unit * 10 + 1, pos = math.random(), name = "iron-plate"} end
                if math.random() < 0.3 then items2[1] = {uid = unit * 10 + 2, pos = math.random(), name = "pistol"} end
                unit = unit + 1
                local b = belt(unit, {line(lane1, items1), line(lane2, items2)})
                if previous then feed(previous, b) end
                belts[#belts + 1] = b
                previous = b
            end
        end
        for i = #belts, 2, -1 do local j = math.random(i) belts[i], belts[j] = belts[j], belts[i] end
        local listed = {}
        local skipped = 0
        for _, b in ipairs(belts) do
            if #belts > 3 and skipped == 0 and math.random() < 0.15 then skipped = 1 else listed[#listed + 1] = b end
        end
        check("random chains, seed " .. seed, listed)
    end
    print("PASS forty random chain layouts, shuffled and with a belt left out, match the pairwise search")
end

assert(logs[#logs]:find("Captured %d+ side group%(s%) from %d+ belt%(s%)"), "capture log line missing")
