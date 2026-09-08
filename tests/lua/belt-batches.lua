-- Pure planner regression; physical movement and parity are tested in belt-boundary.
local planner = dofile("docker/seed-data/external_plugins/surface_export/module/import_phases/belt_batches.lua")
local map, groups = {}, {}
for i = 1, 6 do
    map[i] = {valid = true, unit_number = i, type = "transport-belt",
        belt_neighbours = {inputs = {}, outputs = {}}}
    groups[i] = {members = {{id = i, li = 1}}, slots = {{ct = 1}}}
end
for i = 1, 5 do map[i].belt_neighbours.outputs = {map[i + 1]} end
map[3].type = "splitter"
map[4].type, map[5].type = "underground-belt", "underground-belt"
map[4].underground_belt_neighbour, map[5].underground_belt_neighbour = map[5], map[4]
groups[7] = {members = {{id = 1, li = 2}}, slots = {{ct = 1}}}

local plan = planner.plan(groups, map, 2)
assert(plan.networks == 1 and #plan.batches == 4, "a connected network can span callbacks")
local expected = 1
for _, batch in ipairs(plan.batches) do
    assert(batch.cost <= 2)
    for _, index in ipairs(batch.indices) do
        assert(index == expected, "each captured group must be scheduled exactly once in order")
        expected = expected + 1
    end
end
assert(expected == #groups + 1)
groups[1].members = {{id = 1, li = 1}, {id = 2, li = 1}, {id = 3, li = 1}}
plan = planner.plan(groups, map, 2)
assert(plan.batches[1].cost == 3 and #plan.batches[1].indices == 1,
    "a shared line group stays whole even when it exceeds the target")
assert(plan.batches[2].indices[1] == 2, "oversized group must not swallow the next group")
map[6].type = "loader"
assert(planner.plan(groups, map, 2).atomic_reason, "unsupported isolation keeps conservative fallback")
map[6].type = "transport-belt"
map[6].belt_neighbours.outputs = {{valid = true, unit_number = 99}}
assert(planner.plan(groups, map, 2).atomic_reason == "external belt connection")
map[6].belt_neighbours.outputs = {}
map[6].valid = false
assert(planner.plan(groups, map, 2).atomic_reason == "missing destination entity")
assert(#planner.plan({}, {}, 2).batches == 0)
print("PASS: connected groups, deterministic packing, oversized group, conservative fallbacks, empty payload")
