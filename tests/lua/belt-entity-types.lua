-- Lane splitters and linked belts are belt entities: their lanes are captured, counted by the
-- census and restored, and a linked pair that lives on one platform is reconnected on import.
local root = "docker/seed-data/external_plugins/surface_export/module/"
local noop = function() end
local logs = {}
local modules = {}
local env = setmetatable({storage = {}, game = {tick = 1}, log = function(m) logs[#logs + 1] = m end,
    defines = setmetatable({}, {__index = function() return setmetatable({}, {__index = function() return 1 end}) end})},
    {__index = _G})
env.require = function(path)
    local name = path:match("^modules/surface_export/(.*)$") or path
    if modules[name] then return modules[name] end
    modules[name] = assert(loadfile(root .. name .. ".lua", "t", env))()
    return modules[name]
end
modules["utils/version-compat"] = {}
local GameUtils = env.require("modules/surface_export/utils/game-utils")
modules["utils/util"] = {QUALITY_NORMAL = "normal", make_quality_key = GameUtils.make_quality_key, safe_get = GameUtils.safe_get,
    pcall_warn = function(_, fn) fn() end, get_entity_category = GameUtils.get_entity_category,
    BELT_ENTITY_TYPES = GameUtils.BELT_ENTITY_TYPES}
local scanned = {}
modules["export_scanners/inventory-scanner"] = {
    extract_belt_items = function(entity) scanned[#scanned + 1] = entity.name return {{line = 1, items = {{name = "iron-plate", count = 1, quality = "normal"}}}} end,
    extract_fluidboxes = function() return nil end,
    extract_all_inventories = function() return {} end,
}

do
    for _, kind in ipairs({"transport-belt", "underground-belt", "splitter", "lane-splitter", "loader", "loader-1x1", "linked-belt"}) do
        assert(GameUtils.BELT_ENTITY_TYPES[kind], kind .. " is not a belt entity type")
    end
    assert(GameUtils.get_entity_category({type = "lane-splitter"}) == "splitter", "a lane splitter serializes like a splitter")
    assert(GameUtils.get_entity_category({type = "linked-belt"}) == "linked-belt")
    print("PASS every belt-connectable type is a belt entity type")
end

local function lines_entity(kind, lanes)
    local lines = {}
    for li, contents in ipairs(lanes) do
        lines[li] = {valid = true, get_contents = function() return contents end}
    end
    return {valid = true, type = kind, name = kind, unit_number = 100 + #lanes, position = {x = 0, y = 0},
        get_max_transport_line_index = function() return #lines end,
        get_transport_line = function(li) return lines[li] end}
end

do
    local CargoCounter = env.require("modules/surface_export/validators/cargo-counter")
    local splitter = lines_entity("lane-splitter", {{{name = "iron-plate", count = 2, quality = "normal"}}, {},
        {{name = "copper-plate", count = 1, quality = "rare"}}, {{name = "iron-plate", count = 3, quality = "normal"}}})
    local totals = CargoCounter.count_entity_items(splitter, "belts")
    assert(totals["iron-plate"] == 5 and totals["copper-plate:rare"] == 1, "the census must count every lane of a lane splitter")
    local linked = lines_entity("linked-belt", {{{name = "steel-plate", count = 4, quality = "normal"}}, {}})
    assert(CargoCounter.count_entity_items(linked, "belts")["steel-plate"] == 4, "the census must count a linked belt's lanes")
    local other = lines_entity("inserter", {{{name = "steel-plate", count = 4, quality = "normal"}}})
    assert(next(CargoCounter.count_entity_items(other, "belts")) == nil, "non-belt entities have no belt lanes to count")
    print("PASS the source and destination census count lane splitter and linked belt lanes")
end

do
    local EntityHandlers = env.require("modules/surface_export/export_scanners/entity-handlers")
    local handler = EntityHandlers["linked-belt"]
    local function linked_belt(partner)
        return {valid = true, type = "linked-belt", name = "linked-belt", unit_number = 7, surface_index = 1,
            linked_belt_type = "input", linked_belt_neighbour = partner}
    end
    local partner = {valid = true, type = "linked-belt", name = "linked-belt", unit_number = 8, surface_index = 1}
    EntityHandlers.skip_belt_items = false
    local data = handler(linked_belt(partner))
    assert(data.items and data.items[1].items[1].name == "iron-plate" and scanned[#scanned] == "linked-belt",
        "a linked belt's lanes must be read like any belt")
    assert(data.linked_belt_type == "input" and data.linked_partner_id == 8, "a partner on the same surface is recorded by entity id")
    assert(handler(linked_belt(nil)).linked_partner_id == nil, "an unlinked belt records no partner")
    assert(handler(linked_belt({valid = true, type = "entity-ghost", unit_number = 9, surface_index = 1})).linked_partner_id == nil,
        "a ghost partner is not a link the import can restore")
    assert(handler(linked_belt({valid = true, type = "linked-belt", unit_number = 10, surface_index = 2})).linked_partner_id == nil,
        "a partner on another surface is not part of the platform")
    EntityHandlers.skip_belt_items = true
    assert(#handler(linked_belt(partner)).items == 0, "the batch pass defers lane reads to the belt capture like every belt")
    EntityHandlers.skip_belt_items = false
    print("PASS a linked belt exports its lanes and its same-platform partner")
end

do
    local Deserializer = env.require("modules/surface_export/core/deserializer")
    local connected = {}
    local function linked(id, neighbour)
        local self = {valid = true, type = "linked-belt", name = "linked-belt", position = {x = id, y = 0}, linked_belt_neighbour = neighbour}
        self.connect_linked_belts = function(other)
            connected[#connected + 1] = {id, other}
            self.linked_belt_neighbour = other
            other.linked_belt_neighbour = self
        end
        return self
    end
    local a, b = linked(1), linked(2)
    local map = {[1] = a, [2] = b}
    assert(Deserializer.restore_linked_belts(a, {entity_id = 1, specific_data = {linked_partner_id = 2}}, map) == 1
        and #connected == 1 and connected[1][2] == b, "the input end reconnects to its partner")
    assert(Deserializer.restore_linked_belts(b, {entity_id = 2, specific_data = {linked_partner_id = 1}}, map) == 0
        and #connected == 1, "the partner is already linked back, so the output end does nothing")
    logs = {}
    assert(Deserializer.restore_linked_belts(linked(3), {entity_id = 3, specific_data = {linked_partner_id = 99}}, map) == 0
        and #connected == 1 and logs[#logs]:find("link dropped", 1, true), "a partner outside the payload drops the link and says so")
    assert(Deserializer.restore_linked_belts(linked(4), {entity_id = 4, specific_data = {}}, map) == 0, "no partner recorded, nothing to do")
    assert(Deserializer.restore_linked_belts({valid = true, type = "transport-belt"}, {entity_id = 5, specific_data = {linked_partner_id = 1}}, map) == 0)
    print("PASS a linked pair captured on one platform is reconnected on import")
end

do
    local planner = env.require("modules/surface_export/import_phases/belt_batches")
    local map, groups = {}, {}
    local function belt(i, kind)
        map[i] = {valid = true, unit_number = i, type = kind, belt_neighbours = {inputs = {}, outputs = {}}}
        groups[#groups + 1] = {members = {{id = i, li = 1}}, slots = {{ct = 1}}}
    end
    belt(1, "transport-belt") belt(2, "lane-splitter") belt(3, "transport-belt")
    map[1].belt_neighbours.outputs = {map[2]} map[2].belt_neighbours.inputs = {map[1]}
    map[2].belt_neighbours.outputs = {map[3]} map[3].belt_neighbours.inputs = {map[2]}
    belt(4, "linked-belt") belt(5, "linked-belt")
    map[4].linked_belt_neighbour, map[5].linked_belt_neighbour = map[5], map[4]
    map[3].belt_neighbours.outputs = {map[4]} map[4].belt_neighbours.inputs = {map[3]}
    local plan = planner.plan(groups, map, 2)
    assert(not plan.atomic_reason, "a lane splitter and a linked pair on the platform must not force the atomic fallback: " .. tostring(plan.atomic_reason))
    assert(plan.networks == 1, "the lane splitter and the linked pair join their belts into one network, got " .. tostring(plan.networks))
    map[5].linked_belt_neighbour = {valid = true, unit_number = 999}
    assert(planner.plan(groups, map, 2).atomic_reason == "external linked-belt connection", "a linked partner outside the payload keeps the conservative fallback")
    print("PASS the import planner batches through lane splitters and same-platform linked pairs")
end
