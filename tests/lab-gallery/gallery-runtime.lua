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

local function replace_index_surface(manifest)
    local old = game.surfaces[manifest.surfaceName]
    if old then
        -- game.delete_surface only SCHEDULES deletion, so re-baking from a previous gallery
        -- save would collide on the canonical name in this same execution. Rename first
        -- (immediate), then schedule the delete.
        old.name = manifest.surfaceName .. "-retired"
        assert(game.delete_surface(old), "failed to delete old gallery index")
    end
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

-- Read-only: inspect() must report what the save actually carries, never values the
-- inspection itself just wrote — otherwise the builder's lab-safe gate can never fail.
local function read_lab_surface_settings()
    local rows = {}
    for _, surface in pairs(game.surfaces) do
        rows[#rows + 1] = {
            name = surface.name,
            isPlatform = surface.platform ~= nil,
            generateWithLabTiles = surface.generate_with_lab_tiles,
            hasGlobalElectricNetwork = surface.has_global_electric_network,
            ignoreSurfaceConditions = surface.ignore_surface_conditions,
        }
    end
    table.sort(rows, function(a, b) return a.name < b.name end)
    return rows
end

local function apply_lab_surface_settings()
    for _, surface in pairs(game.surfaces) do
        -- Platform surfaces are MEASURED fixtures: ignore_surface_conditions would change
        -- can_place semantics for the surface-condition entities the reachability lab
        -- classifies, so their physics are never mutated — values recorded as measured.
        if surface.platform == nil then
            surface.generate_with_lab_tiles = true
            -- has_global_electric_network is read-only at 2.0.77; the write path is
            -- create_global_electric_network() and the attribute is its read-back.
            if not surface.has_global_electric_network then surface.create_global_electric_network() end
            surface.ignore_surface_conditions = true
        end
    end
    return read_lab_surface_settings()
end

local function inspect_reachability(specification)
    local surface, platform = FixtureMeters.surface_for_platform(specification.platformName)
    if not platform then return { exists = false, id = reachability_id } end
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
        -- `or false` (never nil): the "no mining target" state is emitted EXPLICITLY so a dropped
        -- read is an absent field the gate rejects, not a vacuous pass self-manufactured downstream.
        miningTarget = drill.mining_target and drill.mining_target.name or false,
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
    -- The 5x5 loop now rides the omnibus loop PAD (was two nauvis loops). Measure it through the shared
    -- FixtureMeters.measure_belt_loop, anchored from the manifest, guarded so the DESTINATION (omnibus
    -- destroyed) reads zeros. There is no empty "target" loop any more, so target* are always zero.
    local measured = FixtureMeters.measure_corpus(manifest)
    local loop = { beltCount = 0, quantity = 0, physicalStacks = 0, maximumStack = 0, lineQuantities = { 0, 0 } }
    local omni_surface = FixtureMeters.surface_for_platform("lab-omnibus-state-v1")
    if omni_surface then
        loop = FixtureMeters.measure_belt_loop(omni_surface, FixtureMeters.anchor_lookup(manifest, "belt-5x5-125-unstacked"))
    end
    local reading = {
        success = true,
        version = script.active_mods.base,
        mods = script.active_mods,
        saveRole = storage.lab_gallery and storage.lab_gallery.saveRole or nil,
        galleryStorage = storage.lab_gallery ~= nil,
        indexSurface = game.surfaces[manifest.surfaceName] ~= nil,
        sourceBelts = loop.beltCount,
        targetBelts = 0,
        sourceQuantity = loop.quantity,
        sourceLineQuantities = loop.lineQuantities,
        targetQuantity = 0,
        maximumStack = loop.maximumStack,
        physicalStacks = loop.physicalStacks,
        reachability = inspect_reachability(specialized),
        surfaceSettings = read_lab_surface_settings(),
        transient = transient_state(),
        census = surface_census(),
        corpus = measured,
    }
    -- expected is sourced from the manifest belt fingerprint (single source of truth), passed via
    -- the belt pilot: beltCount/sourceQuantity/sourceLineQuantities/maximumStack/physicalStacks.
    local expected = pilot.expected
    reading.beltFixtureExact = reading.sourceBelts == expected.beltCount
        and reading.sourceQuantity == expected.sourceQuantity
        and reading.sourceLineQuantities[1] == expected.sourceLineQuantities[1]
        and reading.sourceLineQuantities[2] == expected.sourceLineQuantities[2]
        and reading.targetQuantity == expected.targetQuantity
        and reading.maximumStack == expected.maximumStack
        and reading.physicalStacks == expected.physicalStacks
    local wanted = specialized.expected
    reading.reachabilityFixtureExact = reading.reachability.exists == true
        and reading.reachability.drillExists == true
        and reading.reachability.pressure == wanted.pressure
        and reading.reachability.gravity == wanted.gravity
        and reading.reachability.liveFluidboxCount == wanted.liveFluidboxCount
        and reading.reachability.miningTarget == wanted.miningTarget
        and reading.reachability.readOk == wanted.readOk
        and reading.reachability.writeOk == wanted.writeOk
    reading.corpusGate = FixtureMeters.corpus_gate(manifest, measured)
    reading.corpusExact = reading.corpusGate.exact
    return reading
end

local function normalize_source()
    assert_idle()
    local manifest = assert(request.manifest, "missing manifest")
    local pilot = assert(request.beltPilot, "missing belt pilot")
    assert(request.specializedFixture, "missing specialized fixture")
    -- Verify-not-construct: no platform is created or destroyed and no platform surface is
    -- minimized. The hand-curated corpus is normalized only by rebuilding the index catalog and
    -- applying lab-safe settings to non-platform surfaces; then every fingerprint is physically
    -- verified against the manifest.
    destroy_gallery_rendering()
    local index_surface, renderings, tags = replace_index_surface(manifest)
    apply_lab_surface_settings()
    assert(game.surfaces[pilot.sourceSurface], "missing belt pilot surface")
    storage.lab_gallery = {
        schema = manifest.schema,
        saveRole = "source",
        indexSurfaceName = index_surface.name,
        beltSurfaceName = pilot.sourceSurface,
        renderings = renderings,
        tags = tags,
    }
    local reading = inspect()
    assert(reading.beltFixtureExact, "normalized belt fixture is not exact: " .. helpers.table_to_json(reading))
    assert(reading.reachabilityFixtureExact, "normalized reachability fixture is not exact: " .. helpers.table_to_json(reading))
    assert(reading.corpusExact, "normalized corpus fingerprints are not exact: " .. helpers.table_to_json(reading.corpusGate))
    return reading
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

local function prepare_destination()
    assert_idle()
    local state = assert(storage.lab_gallery, "gallery source has not been normalized")
    local pilot = assert(request.beltPilot, "missing belt pilot")
    local destroyed = destroy_all_platforms()
    local surface = game.surfaces[pilot.sourceSurface]
    for _, entity in ipairs(find_belts(surface, pilot.sourceBelts, false)) do if entity.valid then entity.destroy() end end
    for _, entity in ipairs(find_belts(surface, pilot.targetBelts, false)) do if entity.valid then entity.destroy() end end
    state.saveRole = "destination"
    return { success = true, scheduled = true, saveRole = state.saveRole, platformsScheduled = destroyed }
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
