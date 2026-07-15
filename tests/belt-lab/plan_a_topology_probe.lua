-- Phase A populated-vs-cleared transport-line graph probe for Factorio 2.0.77.
-- Caller sets __belt_plan_a_platform_name before executing this file through /sc.
-- The probe writes full graph JSON to script-output and returns only a compact summary.

local platform_name = __belt_plan_a_platform_name
assert(type(platform_name) == "string" and platform_name ~= "", "missing __belt_plan_a_platform_name")
assert(string.find(platform_name, "plan-a-dup-control-", 1, true) == 1,
    "refusing to mutate a non-disposable platform: " .. platform_name)

local platform = nil
for _, candidate in pairs(game.forces.player.platforms or {}) do
    if candidate.valid and candidate.name == platform_name then
        platform = candidate
        break
    end
end
assert(platform and platform.valid, "platform not found: " .. platform_name)
game.tick_paused = true

local belt_types = {
    "transport-belt", "underground-belt", "splitter",
    "linked-belt", "loader", "loader-1x1",
}

local function runtime_node_key(unit_number, line_index)
    return tostring(unit_number) .. ":" .. tostring(line_index)
end

local function resolve_link(linked_line)
    local owner = linked_line.owner
    if not (owner and owner.valid) then
        return {owner_unit = nil, matches = {}}
    end
    local matches = {}
    for line_index = 1, owner.get_max_transport_line_index() do
        if owner.get_transport_line(line_index).line_equals(linked_line) then
            matches[#matches + 1] = line_index
        end
    end
    return {owner_unit = owner.unit_number, matches = matches}
end

local function build_graph(label)
    local entities = platform.surface.find_entities_filtered {type = belt_types}
    table.sort(entities, function(a, b)
        if a.position.y ~= b.position.y then return a.position.y < b.position.y end
        if a.position.x ~= b.position.x then return a.position.x < b.position.x end
        return (a.unit_number or 0) < (b.unit_number or 0)
    end)

    local nodes = {}
    local node_by_key = {}
    local adjacency = {}
    local ambiguous_links = 0
    local raw_entries = 0
    local raw_quantity = 0
    local unique_quantity = 0
    local unique_entries = 0
    local seen_unique = {}

    for _, entity in ipairs(entities) do
        local max_lines = entity.get_max_transport_line_index()
        for line_index = 1, max_lines do
            local line = entity.get_transport_line(line_index)
            local key = runtime_node_key(entity.unit_number, line_index)
            local node = {
                key = key,
                unit_number = entity.unit_number,
                entity_name = entity.name,
                entity_type = entity.type,
                position = {x = entity.position.x, y = entity.position.y},
                direction = entity.direction,
                line_index = line_index,
                line_length = line.line_length,
                total_segment_length = line.total_segment_length,
                inputs = {},
                outputs = {},
            }
            nodes[#nodes + 1] = node
            node_by_key[key] = node
            adjacency[key] = {}

            for _, item in ipairs(line.get_detailed_contents()) do
                raw_entries = raw_entries + 1
                raw_quantity = raw_quantity + item.stack.count
                if not seen_unique[item.unique_id] then
                    seen_unique[item.unique_id] = true
                    unique_entries = unique_entries + 1
                    unique_quantity = unique_quantity + item.stack.count
                end
            end
        end
    end

    local function add_links(node, linked_lines, field)
        for _, linked_line in ipairs(linked_lines) do
            local resolved = resolve_link(linked_line)
            local row = {owner_unit = resolved.owner_unit, matches = resolved.matches}
            if resolved.owner_unit and #resolved.matches == 1 then
                local other_key = runtime_node_key(resolved.owner_unit, resolved.matches[1])
                row.resolved_key = other_key
                row.resolved_node_present = node_by_key[other_key] ~= nil
                if node_by_key[other_key] then
                    adjacency[node.key][other_key] = true
                    adjacency[other_key][node.key] = true
                else
                    ambiguous_links = ambiguous_links + 1
                end
            else
                ambiguous_links = ambiguous_links + 1
            end
            node[field][#node[field] + 1] = row
        end
    end

    for _, node in ipairs(nodes) do
        local entity = platform.surface.find_entity(node.entity_name, node.position)
        assert(entity and entity.valid and entity.unit_number == node.unit_number,
            "failed to re-resolve entity " .. node.key)
        local line = entity.get_transport_line(node.line_index)
        add_links(node, line.input_lines, "inputs")
        add_links(node, line.output_lines, "outputs")
    end

    local components = {}
    local component_by_node = {}
    local visited = {}
    for _, node in ipairs(nodes) do
        if not visited[node.key] then
            local component = {id = #components + 1, nodes = {}}
            local queue = {node.key}
            local head = 1
            visited[node.key] = true
            while head <= #queue do
                local key = queue[head]
                head = head + 1
                component.nodes[#component.nodes + 1] = key
                component_by_node[key] = component.id
                for other_key in pairs(adjacency[key]) do
                    if not visited[other_key] then
                        visited[other_key] = true
                        queue[#queue + 1] = other_key
                    end
                end
            end
            table.sort(component.nodes)
            components[#components + 1] = component
        end
    end

    for _, node in ipairs(nodes) do node.component = component_by_node[node.key] end
    return {
        label = label,
        platform = platform_name,
        version = script.active_mods.base,
        tick = game.tick,
        game_tick_paused = game.tick_paused,
        entities = #entities,
        nodes = nodes,
        components = components,
        ambiguous_links = ambiguous_links,
        ownership = {
            raw_entries = raw_entries,
            unique_entries = unique_entries,
            duplicate_entries = raw_entries - unique_entries,
            raw_quantity = raw_quantity,
            unique_quantity = unique_quantity,
            duplicate_quantity = raw_quantity - unique_quantity,
        },
    }
end

local safe_name = string.gsub(platform_name, "[^%w_-]", "_")
local populated = build_graph("populated")
local populated_file = "plan_a_topology_populated_" .. safe_name .. ".json"
helpers.write_file(populated_file, helpers.table_to_json(populated), false)

for _, entity in ipairs(platform.surface.find_entities_filtered {type = belt_types}) do
    for line_index = 1, entity.get_max_transport_line_index() do
        entity.get_transport_line(line_index).clear()
    end
end

local cleared = build_graph("cleared")
local cleared_file = "plan_a_topology_cleared_" .. safe_name .. ".json"
helpers.write_file(cleared_file, helpers.table_to_json(cleared), false)

rcon.print(helpers.table_to_json({
    probe = "plan-a-topology",
    version = script.active_mods.base,
    platform = platform_name,
    populated_file = populated_file,
    cleared_file = cleared_file,
    populated = {
        entities = populated.entities,
        nodes = #populated.nodes,
        components = #populated.components,
        ambiguous_links = populated.ambiguous_links,
        ownership = populated.ownership,
    },
    cleared = {
        entities = cleared.entities,
        nodes = #cleared.nodes,
        components = #cleared.components,
        ambiguous_links = cleared.ambiguous_links,
        ownership = cleared.ownership,
    },
}))
