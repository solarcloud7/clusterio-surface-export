-- ADJ-R0 lab runtime. The demo must not weaken this rule to make the replay pass.
-- The caller supplies local `request`; this file returns one JSON-safe result table.

local prefix = "belt-adjacency-r0-"
local belt_types = {"transport-belt", "underground-belt", "splitter"}

local function count_table(value)
    local count = 0
    for _ in pairs(value or {}) do count = count + 1 end
    return count
end

local function get_state()
    local state = storage.belt_adjacency_r0
    local surface = state and state.surface_name and game.get_surface(state.surface_name) or nil
    return state, surface
end

local function item_entity_count(surface)
    local count = 0
    if not surface then return count end
    for _, entity in pairs(surface.find_entities_filtered {type = "item-entity"}) do
        if entity.valid and entity.stack and entity.stack.valid_for_read then count = count + entity.stack.count end
    end
    return count
end

local function belt_item_count(surface)
    local count = 0
    local seen = {}
    if not surface then return count end
    for _, entity in pairs(surface.find_entities_filtered {type = belt_types}) do
        for line_index = 1, entity.get_max_transport_line_index() do
            for _, item in ipairs(entity.get_transport_line(line_index).get_detailed_contents()) do
                if not seen[item.unique_id] then
                    seen[item.unique_id] = true
                    count = count + item.stack.count
                end
            end
        end
    end
    return count
end

local function inspect()
    local lab_surfaces = {}
    local surface_items = 0
    local ground_items = 0
    for _, surface in pairs(game.surfaces) do
        if string.find(surface.name, prefix, 1, true) == 1 then
            lab_surfaces[#lab_surfaces + 1] = surface.name
            surface_items = surface_items + belt_item_count(surface)
            ground_items = ground_items + item_entity_count(surface)
        end
    end
    table.sort(lab_surfaces)
    return {
        success = true,
        version = script.active_mods.base,
        tick = game.tick,
        gamePaused = game.tick_paused == true,
        surfaces = #lab_surfaces,
        surfaceNames = lab_surfaces,
        surfaceItems = surface_items,
        groundItems = ground_items,
        labStorage = storage.belt_adjacency_r0 ~= nil,
        jobs = count_table(storage.async_jobs),
        locks = count_table(storage.locked_platforms),
        holds = count_table(storage.destination_holds),
        tombstones = count_table(storage.committed_source_transfer_tombstones),
    }
end

local function set_pause()
    assert(type(request.expectedCurrent) == "boolean", "set_pause requires expectedCurrent")
    assert(type(request.paused) == "boolean", "set_pause requires paused")
    assert(game.tick_paused == request.expectedCurrent, "pause state changed before owned transition")
    game.tick_paused = request.paused
    assert(game.tick_paused == request.paused, "pause write did not stick")
    return {success = true, tick = game.tick, gamePaused = game.tick_paused == true}
end

local function ensure_surface(surface_name)
    assert(type(surface_name) == "string" and string.find(surface_name, prefix, 1, true) == 1,
        "surface name must use the ADJ-R0 prefix")
    local state, surface = get_state()
    if state then
        assert(state.surface_name == surface_name, "runner attempted to switch disposable surfaces")
        assert(surface, "lab storage points to a missing surface")
        return state, surface
    end
    assert(game.get_surface(surface_name) == nil, "refusing to adopt an existing surface")
    surface = game.create_surface(surface_name, {default_enable_all_autoplace_controls = false})
    storage.belt_adjacency_r0 = {
        surface_name = surface_name,
        source_to_unit = {},
        unit_to_source = {},
        source_descriptors = {},
        prepared_sources = {},
    }
    return storage.belt_adjacency_r0, surface
end

local function heartbeat()
    local state, surface = get_state()
    return {
        success = true,
        tick = game.tick,
        gamePaused = game.tick_paused == true,
        surface = surface and surface.name or nil,
        prepared = count_table(state and state.prepared_sources),
        constructed = count_table(state and state.source_to_unit),
    }
end

local function prepare_terrain()
    assert(type(request.entities) == "table", "prepare_terrain requires entities")
    assert(#request.entities <= 25, "prepare_terrain chunk exceeds 25 entities")
    local state, surface = ensure_surface(request.surfaceName)
    local tiles = {}
    local seen_tiles = {}
    for _, descriptor in ipairs(request.entities) do
        assert(descriptor.type == "transport-belt" or descriptor.type == "underground-belt" or descriptor.type == "splitter",
            "unsupported belt entity type " .. tostring(descriptor.type))
        local source_id = tostring(descriptor.entityId)
        assert(state.prepared_sources[source_id] == nil, "duplicate terrain preparation " .. source_id)
        state.prepared_sources[source_id] = true
        local center_x = math.floor(descriptor.position.x)
        local center_y = math.floor(descriptor.position.y)
        for x = center_x - 1, center_x + 1 do
            for y = center_y - 1, center_y + 1 do
                local key = tostring(x) .. ":" .. tostring(y)
                if not seen_tiles[key] then
                    seen_tiles[key] = true
                    tiles[#tiles + 1] = {name = "landfill", position = {x, y}}
                end
            end
        end
    end
    if #tiles > 0 then surface.set_tiles(tiles, true, true, true, false) end
    return {success = true, tick = game.tick, totalPrepared = count_table(state.prepared_sources)}
end

local function construct()
    assert(type(request.entities) == "table", "construct requires entities")
    assert(#request.entities <= 25, "construct chunk exceeds 25 entities")
    local state, surface = ensure_surface(request.surfaceName)
    local created = {}
    for _, descriptor in ipairs(request.entities) do
        assert(descriptor.type == "transport-belt" or descriptor.type == "underground-belt" or descriptor.type == "splitter",
            "unsupported belt entity type " .. tostring(descriptor.type))
        local source_id = tostring(descriptor.entityId)
        assert(state.prepared_sources[source_id] == true, "descriptor was not terrain-prepared " .. source_id)
        assert(state.source_to_unit[source_id] == nil, "duplicate source entity " .. source_id)
        local specification = {
            name = descriptor.name,
            position = descriptor.position,
            direction = descriptor.direction,
            force = descriptor.force or "player",
            create_build_effect_smoke = false,
        }
        if descriptor.quality then specification.quality = descriptor.quality end
        if descriptor.undergroundType then specification.type = descriptor.undergroundType end
        local entity = surface.create_entity(specification)
        assert(entity and entity.valid, "failed to construct source entity " .. tostring(descriptor.entityId))
        if descriptor.type == "splitter" then
            entity.splitter_filter = descriptor.splitterFilter
            entity.splitter_input_priority = descriptor.inputPriority or "none"
            entity.splitter_output_priority = descriptor.outputPriority or "none"
        end
        state.source_to_unit[source_id] = entity.unit_number
        state.unit_to_source[tostring(entity.unit_number)] = source_id
        state.source_descriptors[source_id] = {
            name = entity.name,
            type = entity.type,
            position = {x = entity.position.x, y = entity.position.y},
            direction = entity.direction,
            underground_type = descriptor.undergroundType,
            expects_partner = descriptor.expectsPartner,
            splitter_filter = descriptor.splitterFilter,
            input_priority = descriptor.inputPriority,
            output_priority = descriptor.outputPriority,
            unit_number = entity.unit_number,
        }
        created[#created + 1] = {entityId = descriptor.entityId, unitNumber = entity.unit_number}
    end
    return {success = true, tick = game.tick, created = created, totalCreated = count_table(state.source_to_unit)}
end

local function neighbour_ids(entities, unit_to_source)
    local result = {}
    for _, entity in pairs(entities or {}) do
        local source_id = entity.valid and unit_to_source[tostring(entity.unit_number)] or nil
        if source_id then result[#result + 1] = source_id end
    end
    table.sort(result)
    return result
end

local function geometry_for(entity, line_index)
    local line = entity.get_transport_line(line_index)
    local start = entity.get_line_item_position(line_index, 0)
    local finish = entity.get_line_item_position(line_index, line.line_length)
    local start_line, start_position = entity.get_item_insert_specification(start)
    local finish_line, finish_position = entity.get_item_insert_specification(finish)
    return {
        lineLength = line.line_length,
        start = {x = start.x, y = start.y},
        finish = {x = finish.x, y = finish.y},
        startInsert = {line = start_line, position = start_position},
        finishInsert = {line = finish_line, position = finish_position},
    }
end

local function observe_graph()
    local state, surface = get_state()
    assert(state and surface, "observe_graph requires a constructed surface")
    local rows = {}
    for source_id, descriptor in pairs(state.source_descriptors) do
        local unit_number = state.source_to_unit[source_id]
        local entity = surface.find_entity(descriptor.name, descriptor.position)
        assert(entity and entity.valid and entity.unit_number == unit_number,
            "constructed entity disappeared or changed identity: " .. source_id)
        local belt_neighbours = entity.belt_neighbours or {inputs = {}, outputs = {}}
        local partner = nil
        if entity.type == "underground-belt" then partner = entity.neighbours end
        local partner_id = nil
        if partner and partner.valid then partner_id = state.unit_to_source[tostring(partner.unit_number)] end
        local lines = {}
        for line_index = 1, entity.get_max_transport_line_index() do
            local geometry_ok, geometry = pcall(geometry_for, entity, line_index)
            assert(geometry_ok, "geometry failed for " .. source_id .. " (" .. entity.type .. ") line "
                .. tostring(line_index) .. ": " .. tostring(geometry))
            lines[#lines + 1] = {
                index = line_index,
                geometry = geometry,
            }
        end
        local splitter_filter = nil
        local input_priority = nil
        local output_priority = nil
        if entity.type == "splitter" then
            splitter_filter = entity.splitter_filter and entity.splitter_filter.name or nil
            input_priority = entity.splitter_input_priority
            output_priority = entity.splitter_output_priority
        end
        local expects_partner = nil
        if entity.type == "underground-belt" then expects_partner = descriptor.expects_partner == true end
        rows[#rows + 1] = {
            entityId = source_id,
            unitNumber = unit_number,
            name = entity.name,
            type = entity.type,
            position = {x = entity.position.x, y = entity.position.y},
            direction = entity.direction,
            beltShape = entity.type == "transport-belt" and entity.belt_shape or nil,
            undergroundType = entity.type == "underground-belt" and entity.belt_to_ground_type or nil,
            expectsPartner = expects_partner,
            inputs = neighbour_ids(belt_neighbours.inputs, state.unit_to_source),
            outputs = neighbour_ids(belt_neighbours.outputs, state.unit_to_source),
            undergroundPartner = partner_id,
            splitterFilter = splitter_filter,
            inputPriority = input_priority,
            outputPriority = output_priority,
            lines = lines,
        }
    end
    table.sort(rows, function(left, right) return tonumber(left.entityId) < tonumber(right.entityId) end)
    return {
        success = true,
        version = script.active_mods.base,
        tick = game.tick,
        gamePaused = game.tick_paused == true,
        surfaceItems = belt_item_count(surface),
        groundItems = item_entity_count(surface),
        entities = rows,
    }
end

local function cleanup()
    -- Sweep by the same prefix predicate inspect() uses so an orphaned lab surface
    -- (one with no storage record) can never permanently block preflight.
    local deleted = {}
    for _, surface in pairs(game.surfaces) do
        if string.find(surface.name, prefix, 1, true) == 1 then
            deleted[#deleted + 1] = surface.name
            game.delete_surface(surface)
        end
    end
    table.sort(deleted)
    storage.belt_adjacency_r0 = nil
    return {
        success = true,
        tick = game.tick,
        deleted = (#deleted > 0) and deleted or nil,
        gamePaused = game.tick_paused == true,
    }
end

assert(type(request) == "table" and type(request.operation) == "string", "missing ADJ-R0 request")
local profiler = game.create_profiler()
local result = nil
if request.operation == "inspect" then result = inspect()
elseif request.operation == "set_pause" then result = set_pause()
elseif request.operation == "heartbeat" then result = heartbeat()
elseif request.operation == "prepare_terrain" then result = prepare_terrain()
elseif request.operation == "construct" then result = construct()
elseif request.operation == "observe_graph" then result = observe_graph()
elseif request.operation == "cleanup" then result = cleanup()
else error("unsupported ADJ-R0 operation " .. request.operation) end
profiler.stop()
result.profiler = profiler
return result
