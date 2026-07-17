local expected_version = "2.0.77"
local prefix = "lab-gallery-"
local operation = request.operation

local function assert_engine()
    assert(script.active_mods.base == expected_version,
        "lab gallery requires Factorio " .. expected_version .. ", got " .. tostring(script.active_mods.base))
end

local function current_state()
    local state = storage.lab_gallery
    if state and state.indexSurface and state.indexSurface.valid then return state end
    return nil
end

local function table_size(value)
    local count = 0
    for _ in pairs(value or {}) do count = count + 1 end
    return count
end

local function preflight()
    local surfaces = 0
    for _, surface in pairs(game.surfaces) do
        if string.sub(surface.name, 1, #prefix) == prefix then surfaces = surfaces + 1 end
    end
    return {
        success = true,
        version = script.active_mods.base,
        gamePaused = game.tick_paused,
        surfaces = surfaces,
        labStorage = storage.lab_gallery ~= nil,
        jobs = table_size(storage.async_jobs),
        locks = table_size(storage.locked_platforms),
        holds = table_size(storage.destination_holds),
        tombstones = table_size(storage.committed_source_transfer_tombstones),
    }
end

local function detailed_census(belts, selected_line)
    local seen = {}
    local quantity = 0
    local maximum_stack = 0
    local physical_stacks = 0
    for _, belt in ipairs(belts or {}) do
        if belt and belt.valid then
            local first_line = selected_line or 1
            local last_line = selected_line or belt.get_max_transport_line_index()
            for line_index = first_line, last_line do
                local line = belt.get_transport_line(line_index)
                for _, row in ipairs(line.get_detailed_contents()) do
                    if not seen[row.unique_id] then
                        seen[row.unique_id] = true
                        quantity = quantity + row.stack.count
                        maximum_stack = math.max(maximum_stack, row.stack.count)
                        physical_stacks = physical_stacks + 1
                    end
                end
            end
        end
    end
    return { quantity = quantity, maximumStack = maximum_stack, physicalStacks = physical_stacks }
end

local function inspect()
    local state = current_state()
    if not state then return { success = true, exists = false } end
    local source = detailed_census(state.sourceBelts)
    local target = detailed_census(state.targetBelts)
    local source_lines = {
        detailed_census(state.sourceBelts, 1).quantity,
        detailed_census(state.sourceBelts, 2).quantity,
    }
    return {
        success = true,
        exists = true,
        finalized = state.finalized == true,
        surface = state.sourceSurface.name,
        indexSurface = state.indexSurface.name,
        labCount = state.labCount,
        sourceQuantity = source.quantity,
        sourceLineQuantities = source_lines,
        targetQuantity = target.quantity,
        maximumStack = source.maximumStack,
        physicalStacks = source.physicalStacks,
        expected = state.expected,
    }
end

local function create_belts(surface, descriptors, result)
    result = result or {}
    for _, descriptor in ipairs(descriptors) do
        local entity = surface.create_entity({
            name = descriptor.name,
            position = descriptor.position,
            direction = defines.direction[descriptor.direction],
            force = "player",
            create_build_effect_smoke = false,
        })
        assert(entity and entity.valid, "failed to create belt at "
            .. tostring(descriptor.position.x) .. "," .. tostring(descriptor.position.y))
        result[#result + 1] = entity
    end
    return result
end

local function adopt_belts(surface, descriptors)
    local result = {}
    for _, descriptor in ipairs(descriptors) do
        local entity = surface.find_entity(descriptor.name, descriptor.position)
        assert(entity and entity.valid, "missing adopted source belt at "
            .. tostring(descriptor.position.x) .. "," .. tostring(descriptor.position.y))
        assert(entity.direction == defines.direction[descriptor.direction], "adopted source belt direction changed at "
            .. tostring(descriptor.position.x) .. "," .. tostring(descriptor.position.y))
        result[#result + 1] = entity
    end
    return result
end

local function build()
    assert_engine()
    local before = preflight()
    assert(not before.gamePaused and before.surfaces == 0 and not before.labStorage
        and before.jobs == 0 and before.locks == 0 and before.holds == 0 and before.tombstones == 0,
        "lab gallery preflight is not idle: " .. helpers.table_to_json(before))
    assert(current_state() == nil, "lab gallery already exists")
    for _, surface in pairs(game.surfaces) do
        assert(string.sub(surface.name, 1, #prefix) ~= prefix, "foreign lab gallery surface exists: " .. surface.name)
    end

    local manifest = request.manifest
    local pilot = request.beltPilot
    assert(manifest and manifest.surfaceName and manifest.labs, "missing gallery manifest")
    assert(pilot and pilot.expected and pilot.sourceBelts and pilot.targetBelts, "missing belt pilot")
    local index_surface = game.create_surface(manifest.surfaceName, { width = 1024, height = 768 })
    storage.lab_gallery = {
        indexSurface = index_surface,
        sourceBelts = {},
        targetBelts = {},
        sourceRenderings = {},
        sourceTags = {},
        expected = pilot.expected,
        labCount = #manifest.labs,
        finalized = false,
    }
    local state = storage.lab_gallery

    for _, lab in ipairs(manifest.labs) do
        local tiles = {}
        for x = lab.zone.x - 8, lab.zone.x + 32 do
            for y = lab.zone.y - 8, lab.zone.y + 32 do
                tiles[#tiles + 1] = { name = "refined-concrete", position = { x, y } }
            end
        end
        index_surface.set_tiles(tiles, true, false, true, false)
        rendering.draw_text({
            text = lab.title .. "\n" .. lab.id .. "\n" .. lab.purpose,
            surface = index_surface,
            target = { lab.zone.x, lab.zone.y - 6 },
            color = lab.mode == "baked-source" and { 0.3, 1, 0.4 } or { 0.65, 0.75, 1 },
            scale = 1.5,
            scale_with_zoom = false,
        })
        game.forces.player.add_chart_tag(index_surface, {
            position = lab.zone,
            text = lab.title,
        })
    end

    local source_surface = assert(game.surfaces[pilot.sourceSurface], "missing adopted source surface")
    state.sourceSurface = source_surface
    state.sourceBelts = adopt_belts(source_surface, pilot.sourceBelts)
    local adopted = inspect()
    assert(adopted.sourceQuantity == pilot.expected.sourceQuantity
        and adopted.sourceLineQuantities[1] == pilot.expected.sourceLineQuantities[1]
        and adopted.sourceLineQuantities[2] == pilot.expected.sourceLineQuantities[2]
        and adopted.maximumStack == pilot.expected.maximumStack,
        "adopted source fixture failed independent census: " .. helpers.table_to_json(adopted))
    create_belts(source_surface, pilot.targetBelts, state.targetBelts)

    state.sourceRenderings[#state.sourceRenderings + 1] = rendering.draw_text({
        text = "SOURCE: immutable 125 unstacked iron plates",
        surface = source_surface,
        target = { pilot.sourceBelts[1].position.x, pilot.sourceBelts[1].position.y - 3 },
        color = { 0.3, 1, 0.4 },
        scale = 1.2,
    })
    state.sourceRenderings[#state.sourceRenderings + 1] = rendering.draw_text({
        text = "TARGET: empty; test runners populate and independently meter it",
        surface = source_surface,
        target = { pilot.targetBelts[1].position.x, pilot.targetBelts[1].position.y - 3 },
        color = { 1, 0.85, 0.3 },
        scale = 1.2,
    })

    state.sourceTags[#state.sourceTags + 1] = game.forces.player.add_chart_tag(source_surface, {
        position = pilot.sourceBelts[1].position,
        text = "LAB SOURCE - 125 iron plates (67/58)",
    })
    state.sourceTags[#state.sourceTags + 1] = game.forces.player.add_chart_tag(source_surface, {
        position = pilot.targetBelts[1].position,
        text = "LAB TARGET - empty",
    })
    game.forces.player.chart(index_surface, { { -32, -32 }, { 384, 256 } })
    game.forces.player.chart(source_surface, { { -24, -32 }, { 16, -16 } })
    return inspect()
end

local function finalize()
    local state = assert(current_state(), "lab gallery does not exist")
    local reading = inspect()
    local expected = state.expected
    assert(reading.sourceQuantity == expected.sourceQuantity,
        "source quantity is " .. reading.sourceQuantity .. ", expected " .. expected.sourceQuantity)
    assert(reading.sourceLineQuantities[1] == expected.sourceLineQuantities[1]
        and reading.sourceLineQuantities[2] == expected.sourceLineQuantities[2],
        "source per-line quantities do not match")
    assert(reading.targetQuantity == expected.targetQuantity,
        "target quantity is " .. reading.targetQuantity .. ", expected " .. expected.targetQuantity)
    assert(reading.maximumStack == expected.maximumStack,
        "maximum stack is " .. reading.maximumStack .. ", expected " .. expected.maximumStack)
    state.finalized = true
    state.sourceRenderings[#state.sourceRenderings + 1] = rendering.draw_text({
        text = "READY - baked fixture independently verified",
        surface = state.sourceSurface,
        target = { state.targetBelts[1].position.x, state.targetBelts[1].position.y + 7 },
        color = { 0.2, 1, 0.2 },
        scale = 1.5,
    })
    return inspect()
end

local function save()
    local state = assert(current_state(), "lab gallery does not exist")
    assert(state.finalized == true, "lab gallery must be finalized before save")
    assert(type(request.saveName) == "string" and string.sub(request.saveName, 1, #prefix) == prefix,
        "save name must use the lab gallery prefix")
    game.server_save(request.saveName)
    return { success = true, saveScheduled = request.saveName, reading = inspect() }
end

local function cleanup()
    local state = current_state()
    local deleted = false
    if state then
        for _, entity in ipairs(state.targetBelts or {}) do if entity and entity.valid then entity.destroy() end end
        for _, object in ipairs(state.sourceRenderings or {}) do if object and object.valid then object.destroy() end end
        for _, tag in ipairs(state.sourceTags or {}) do if tag and tag.valid then tag.destroy() end end
        deleted = game.delete_surface(state.indexSurface)
    end
    storage.lab_gallery = nil
    return { success = true, deleted = deleted, exists = current_state() ~= nil }
end

if operation == "preflight" then return preflight()
elseif operation == "build" then return build()
elseif operation == "inspect" then return inspect()
elseif operation == "finalize" then return finalize()
elseif operation == "save" then return save()
elseif operation == "cleanup" then return cleanup()
else error("unsupported lab gallery operation " .. tostring(operation)) end
