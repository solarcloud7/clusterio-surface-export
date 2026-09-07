-- A connected network must be written and checked in one callback: transport lines
-- cannot be paused by disabled_by_script. Independent networks may yield between writes.
local BeltBatches = {}

function BeltBatches.plan(groups, entity_map, budget)
    local parent, owner, units, entities = {}, {}, {}, {}
    local function root(i)
        while parent[i] ~= i do parent[i] = parent[parent[i]]; i = parent[i] end
        return i
    end
    local function join(a, b)
        a, b = root(a), root(b)
        if a ~= b then parent[math.max(a, b)] = math.min(a, b) end
    end
    local function atomic(reason)
        local indices, cost = {}, 0
        for i, g in ipairs(groups) do indices[#indices + 1] = i; cost = cost + math.max(#g.slots, #g.members, 1) end
        return { batches = {{ indices = indices, cost = cost }}, cursor = 1, networks = 1, atomic_reason = reason }
    end
    for i in ipairs(groups) do parent[i] = i end
    for i, g in ipairs(groups) do
        for _, member in ipairs(g.members) do
            local entity = entity_map[member.id]
            if not entity or not entity.valid then return atomic("missing destination entity") end
            if entity.type ~= "transport-belt" and entity.type ~= "underground-belt" and entity.type ~= "splitter" then
                return atomic("unsupported isolation boundary: " .. entity.type)
            end
            if owner[member.id] then join(i, owner[member.id])
            else
                owner[member.id] = i
                units[entity.unit_number] = i
                entities[#entities + 1] = { entity = entity, group = i }
            end
        end
    end
    local function connect(i, neighbour)
        if not neighbour then return true end
        local other = neighbour.valid and units[neighbour.unit_number]
        if not other then return false end
        join(i, other)
        return true
    end
    for _, entry in ipairs(entities) do
        local neighbours = entry.entity.belt_neighbours
        for _, list in ipairs({neighbours.inputs, neighbours.outputs}) do
            for _, neighbour in pairs(list) do
                if not connect(entry.group, neighbour) then return atomic("external belt connection") end
            end
        end
        if entry.entity.type == "underground-belt"
            and not connect(entry.group, entry.entity.underground_belt_neighbour) then
            return atomic("external underground connection")
        end
    end
    local components, ordered = {}, {}
    for i, g in ipairs(groups) do
        local key = root(i)
        if not components[key] then
            components[key] = { indices = {}, cost = 0 }
            ordered[#ordered + 1] = components[key]
        end
        local component = components[key]
        component.indices[#component.indices + 1] = i
        component.cost = component.cost + math.max(#g.slots, #g.members, 1)
    end
    local batches, current = {}, nil
    for _, component in ipairs(ordered) do
        if not current or current.cost + component.cost > budget then
            current = { indices = {}, cost = 0 }; batches[#batches + 1] = current
        end
        for _, i in ipairs(component.indices) do current.indices[#current.indices + 1] = i end
        current.cost = current.cost + component.cost
    end
    return { batches = batches, cursor = 1, networks = #ordered }
end

return BeltBatches
