local expected_version = "2.0.77"
local prefix = "lab-gallery-"
local reachability_id = "specialized-fluid-reachability"
local operation = request.operation

local function table_size(value)
    local count = 0
    for _ in pairs(value or {}) do count = count + 1 end
    return count
end

local function assert_engine()
    assert(script.active_mods.base == expected_version,
        "lab gallery requires Factorio " .. expected_version .. ", got " .. tostring(script.active_mods.base))
end

local function transient_state()
    return {
        gamePaused = not not game.tick_paused,
        jobs = table_size(storage.async_jobs),
        locks = table_size(storage.locked_platforms),
        holds = table_size(storage.destination_holds),
        tombstones = table_size(storage.committed_source_transfer_tombstones),
    }
end

local function preflight()
    assert_engine()
    local result = transient_state()
    result.success = true
    result.version = script.active_mods.base
    result.labStorage = storage.lab_gallery ~= nil
    result.surfaces = 0
    for _, surface in pairs(game.surfaces) do
        if string.sub(surface.name, 1, #prefix) == prefix then result.surfaces = result.surfaces + 1 end
    end
    return result
end

local function assert_idle()
    local state = preflight()
    assert(not state.gamePaused and state.jobs == 0 and state.locks == 0 and state.holds == 0 and state.tombstones == 0,
        "lab gallery seed is not idle: " .. helpers.table_to_json(state))
end

local function destroy_gallery_rendering()
    local old = storage.lab_gallery
    if old then
        for _, key in ipairs({ "sourceRenderings", "renderings" }) do
            for _, object in ipairs(old[key] or {}) do
                if object and object.valid then object.destroy() end
            end
        end
        for _, key in ipairs({ "sourceTags", "tags" }) do
            for _, tag in ipairs(old[key] or {}) do
                if tag and tag.valid then tag.destroy() end
            end
        end
    end
end

local function detailed_census(belts, selected_line)
    local seen, quantity, maximum_stack, physical_stacks = {}, 0, 0, 0
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

local function find_belts(surface, descriptors, required)
    local result = {}
    for _, descriptor in ipairs(descriptors or {}) do
        local entity = surface and surface.find_entity(descriptor.name, descriptor.position) or nil
        if entity and entity.valid then
            assert(entity.direction == defines.direction[descriptor.direction], "belt direction changed at "
                .. tostring(descriptor.position.x) .. "," .. tostring(descriptor.position.y))
            result[#result + 1] = entity
        elseif required then
            error("missing baked belt at " .. tostring(descriptor.position.x) .. "," .. tostring(descriptor.position.y))
        end
    end
    return result
end

local function destroy_all_platforms()
    local platforms = {}
    for _, platform in pairs(game.forces.player.platforms) do
        if platform.valid then platforms[#platforms + 1] = platform end
    end
    for _, platform in ipairs(platforms) do
        if platform.valid then platform.destroy(0) end
    end
    return #platforms
end

local function minimize_nauvis(pilot)
    local surface = assert(game.surfaces[pilot.sourceSurface], "missing belt source surface")
    local source = find_belts(surface, pilot.sourceBelts, true)
    local target = find_belts(surface, pilot.targetBelts, true)
    local protected = {}
    for _, entity in ipairs(source) do protected[entity.unit_number] = true end
    for _, entity in ipairs(target) do protected[entity.unit_number] = true end
    for _, entity in ipairs(surface.find_entities_filtered({})) do
        if entity.valid and not protected[entity.unit_number] then entity.destroy() end
    end
    local keep = { ["-1,-1"] = true, ["0,-1"] = true }
    local chunks = {}
    for chunk in surface.get_chunks() do chunks[#chunks + 1] = { x = chunk.x, y = chunk.y } end
    for _, chunk in ipairs(chunks) do
        if not keep[tostring(chunk.x) .. "," .. tostring(chunk.y)] then surface.delete_chunk(chunk) end
    end
    return surface, source, target
end

local function replace_index_surface(manifest)
    local old = game.surfaces[manifest.surfaceName]
    if old then assert(game.delete_surface(old), "failed to delete old gallery index") end
    local surface = game.create_surface(manifest.surfaceName, {
        width = 128,
        height = 96,
        default_enable_all_autoplace_controls = false,
        autoplace_settings = {
            entity = { treat_missing_as_default = false, settings = {} },
            decorative = { treat_missing_as_default = false, settings = {} },
        },
    })
    local renderings, tags = {}, {}
    for _, lab in ipairs(manifest.labs) do
        local tiles = {}
        for x = lab.zone.x - 5, lab.zone.x + 5 do
            for y = lab.zone.y - 4, lab.zone.y + 4 do
                tiles[#tiles + 1] = { name = "refined-concrete", position = { x, y } }
            end
        end
        surface.set_tiles(tiles, true, false, true, false)
        renderings[#renderings + 1] = rendering.draw_text({
            text = lab.title .. "\n" .. lab.id,
            surface = surface,
            target = { lab.zone.x, lab.zone.y - 3 },
            color = { 0.65, 0.85, 1 },
            scale = 0.9,
            scale_with_zoom = false,
        })
        tags[#tags + 1] = game.forces.player.add_chart_tag(surface, { position = lab.zone, text = lab.title })
    end
    game.forces.player.chart(surface, { { -48, -32 }, { 48, 32 } })
    return surface, renderings, tags
end

local function remove_unrelated_surfaces(keep_names)
    local names = {}
    for name in pairs(game.surfaces) do
        if not keep_names[name] then names[#names + 1] = name end
    end
    local refused = {}
    for _, name in ipairs(names) do
        local surface = game.surfaces[name]
        if surface and not game.delete_surface(surface) then refused[#refused + 1] = name end
    end
    assert(#refused == 0, "engine refused unrelated surfaces: " .. table.concat(refused, ","))
end

local function create_reachability_fixture(specification)
    local force = game.forces.player
    local platform = assert(force.create_space_platform({
        name = specification.platformName,
        planet = "nauvis",
        starter_pack = "space-platform-starter-pack",
    }), "failed to create specialized reachability platform")
    assert(platform.apply_starter_pack(), "failed to apply platform starter pack")
    platform.paused = true
    local surface = platform.surface
    local foundation = {}
    for x = 16, 24 do
        for y = -4, 4 do foundation[#foundation + 1] = { name = "space-platform-foundation", position = { x, y } } end
    end
    surface.set_tiles(foundation, true, false, true, false)
    local position = assert(surface.find_non_colliding_position(specification.drillName, { x = 20, y = 0 }, 8, 0.5),
        "no platform position for electric-mining-drill")
    assert(surface.can_place_entity({ name = specification.drillName, position = position, force = force }),
        "platform rejected electric-mining-drill")
    local drill = assert(surface.create_entity({
        name = specification.drillName,
        position = position,
        force = force,
        create_build_effect_smoke = false,
    }), "electric-mining-drill creation failed")
    return platform, drill
end

local function inspect_reachability(specification)
    local platform
    for _, candidate in pairs(game.forces.player.platforms) do
        if candidate.valid and candidate.name == specification.platformName then platform = candidate break end
    end
    if not platform then return { exists = false, id = reachability_id } end
    local surface = platform.surface
    local drills = surface.find_entities_filtered({ name = specification.drillName })
    local drill = drills[1]
    if not (drill and drill.valid) then return { exists = true, drillExists = false, id = reachability_id } end
    local read_ok, read_value = pcall(function() return drill.fluidbox[1] end)
    local write_ok, write_error = pcall(function() drill.fluidbox[1] = { name = "water", amount = 1 } end)
    return {
        exists = true,
        id = reachability_id,
        platformName = platform.name,
        platformPaused = platform.paused,
        drillExists = true,
        drillName = drill.name,
        pressure = surface.get_property("pressure"),
        gravity = surface.get_property("gravity"),
        liveFluidboxCount = #drill.fluidbox,
        miningTarget = drill.mining_target and drill.mining_target.name or nil,
        readOk = read_ok,
        readValue = read_ok and read_value or nil,
        readError = read_ok and nil or tostring(read_value),
        writeOk = write_ok,
        writeError = write_ok and nil or tostring(write_error),
        entityCount = #surface.find_entities_filtered({}),
    }
end

local function surface_census()
    local rows, total_entities, total_chunks = {}, 0, 0
    for _, surface in pairs(game.surfaces) do
        local chunks = 0
        for _ in surface.get_chunks() do chunks = chunks + 1 end
        local entities = #surface.find_entities_filtered({})
        total_entities = total_entities + entities
        total_chunks = total_chunks + chunks
        rows[#rows + 1] = { name = surface.name, entityCount = entities, generatedChunks = chunks,
            platform = surface.platform and surface.platform.valid and surface.platform.name or nil,
            planet = surface.planet and surface.planet.name or nil }
    end
    table.sort(rows, function(a, b) return a.name < b.name end)
    return { surfaces = rows, totalEntities = total_entities, totalGeneratedChunks = total_chunks }
end

local function inspect()
    assert_engine()
    local manifest = request.manifest
    local pilot = request.beltPilot
    local specialized = request.specializedFixture
    assert(manifest and pilot and specialized, "inspect requires manifest and fixture specifications")
    local surface = game.surfaces[pilot.sourceSurface]
    local source = find_belts(surface, pilot.sourceBelts, false)
    local target = find_belts(surface, pilot.targetBelts, false)
    local all = detailed_census(source)
    local reading = {
        success = true,
        version = script.active_mods.base,
        mods = script.active_mods,
        saveRole = storage.lab_gallery and storage.lab_gallery.saveRole or nil,
        galleryStorage = storage.lab_gallery ~= nil,
        indexSurface = game.surfaces[manifest.surfaceName] ~= nil,
        sourceBelts = #source,
        targetBelts = #target,
        sourceQuantity = all.quantity,
        sourceLineQuantities = { detailed_census(source, 1).quantity, detailed_census(source, 2).quantity },
        targetQuantity = detailed_census(target).quantity,
        maximumStack = all.maximumStack,
        physicalStacks = all.physicalStacks,
        reachability = inspect_reachability(specialized),
        transient = transient_state(),
        census = surface_census(),
    }
    local expected = pilot.expected
    reading.beltFixtureExact = reading.sourceBelts == 16 and reading.targetBelts == 16
        and reading.sourceQuantity == expected.sourceQuantity
        and reading.sourceLineQuantities[1] == expected.sourceLineQuantities[1]
        and reading.sourceLineQuantities[2] == expected.sourceLineQuantities[2]
        and reading.targetQuantity == expected.targetQuantity
        and reading.maximumStack == expected.maximumStack
        and reading.physicalStacks == expected.sourceQuantity
    local wanted = specialized.expected
    reading.reachabilityFixtureExact = reading.reachability.exists == true
        and reading.reachability.drillExists == true
        and reading.reachability.pressure == wanted.pressure
        and reading.reachability.gravity == wanted.gravity
        and reading.reachability.liveFluidboxCount == wanted.liveFluidboxCount
        and reading.reachability.miningTarget == wanted.miningTarget
        and reading.reachability.readOk == wanted.readOk
        and reading.reachability.writeOk == wanted.writeOk
    return reading
end

local function normalize_source()
    assert_idle()
    local manifest = assert(request.manifest, "missing manifest")
    local pilot = assert(request.beltPilot, "missing belt pilot")
    local specialized = assert(request.specializedFixture, "missing specialized fixture")
    destroy_gallery_rendering()
    destroy_all_platforms()
    local source_surface, source_belts, target_belts = minimize_nauvis(pilot)
    local index_surface, renderings, tags = replace_index_surface(manifest)
    remove_unrelated_surfaces({ [source_surface.name] = true, [index_surface.name] = true })
    local platform, drill = create_reachability_fixture(specialized)
    storage.lab_gallery = {
        schema = manifest.schema,
        saveRole = "source",
        indexSurfaceName = index_surface.name,
        beltSurfaceName = source_surface.name,
        reachabilityPlatformName = platform.name,
        reachabilityDrillUnitNumber = drill.unit_number,
        sourceBelts = source_belts,
        targetBelts = target_belts,
        renderings = renderings,
        tags = tags,
    }
    local reading = inspect()
    assert(reading.beltFixtureExact, "normalized belt fixture is not exact: " .. helpers.table_to_json(reading))
    assert(reading.reachabilityFixtureExact, "normalized reachability fixture is not exact: " .. helpers.table_to_json(reading))
    return reading
end

local function prepare_destination()
    assert_idle()
    local state = assert(storage.lab_gallery, "gallery source has not been normalized")
    local pilot = assert(request.beltPilot, "missing belt pilot")
    for _, platform in pairs(game.forces.player.platforms) do
        if platform.valid and platform.name == state.reachabilityPlatformName then platform.destroy(0) end
    end
    local surface = game.surfaces[pilot.sourceSurface]
    for _, entity in ipairs(find_belts(surface, pilot.sourceBelts, false)) do if entity.valid then entity.destroy() end end
    for _, entity in ipairs(find_belts(surface, pilot.targetBelts, false)) do if entity.valid then entity.destroy() end end
    state.sourceBelts = {}
    state.targetBelts = {}
    state.saveRole = "destination"
    return { success = true, scheduled = true, saveRole = state.saveRole }
end

local function save()
    assert_idle()
    assert(type(request.saveName) == "string" and string.sub(request.saveName, 1, #prefix) == prefix,
        "save name must use the lab gallery prefix")
    game.server_save(request.saveName)
    return { success = true, saveScheduled = request.saveName }
end

if operation == "preflight" then return preflight()
elseif operation == "normalize_source" then return normalize_source()
elseif operation == "inspect" then return inspect()
elseif operation == "prepare_destination" then return prepare_destination()
elseif operation == "save" then return save()
else error("unsupported lab gallery operation " .. tostring(operation)) end
