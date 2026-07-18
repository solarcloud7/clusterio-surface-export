-- Seed-prep CONSTRUCTION operations (runtime-driver.cjs protocol: this file is the body of a
-- function receiving a JSON `request` global; it must return a table with success=true).
--
-- gallery-runtime.lua is verify-only by design; construction lives HERE, runs ONLY inside the
-- isolated seed-prep Factorio (never on the cluster), and every operation is committed so the
-- corpus stays reproducible from `seed → operations → candidate` with no hand-curation.
--
-- Operation dispatch: request.operation ∈ preflight | build_census_fusion |
-- measure_census_fusion | freeze_census_fusion | save.

local FUSION_PLATFORM = "lab-census-fusion-v1"

-- Fusion geometry from the measured workhorse layout (live probe 2026-07-17, 2.0.77): reactor at
-- origin, ONE generator at offset (+0.5,-5.5), both facing north — the arrangement whose plasma
-- output segment is SHARED with the generator input (the reactor box exposes the segment ID; the
-- generator input reads nil — see the api-notes fusion entry). ONE generator is the minimal state
-- that proves the shared-segment law (corpus minimality); a second at the workhorse's (-2.5,-5.5)
-- measured status no_input_fluid here (not plasma-connected in this reduced layout), so it is
-- deliberately absent.
local REACTOR_POSITION = { x = 0, y = 0 }
local GENERATOR_POSITIONS = {
    { x = 0.5, y = -5.5 },
}
-- Temporary ignition power; removed by freeze_census_fusion.
local TEMP_POWER_POSITION = { x = 6, y = 0 }

local function find_platform(name)
    for _, platform in pairs(game.forces["player"].platforms) do
        if platform.name == name then return platform end
    end
    return nil
end

local function fusion_entities(surface)
    local reactor = surface.find_entities_filtered({ name = "fusion-reactor" })[1]
    local generators = surface.find_entities_filtered({ name = "fusion-generator" })
    return reactor, generators
end

--- Physical measurement of the fixture: the SAME reads the fingerprint pins.
local STATUS_NAMES = nil
local function status_name(status)
    if not STATUS_NAMES then
        STATUS_NAMES = {}
        for name, value in pairs(defines.entity_status) do STATUS_NAMES[value] = name end
    end
    return STATUS_NAMES[status] or tostring(status)
end

local function measure(surface)
    local reactor, generators = fusion_entities(surface)
    if not reactor then return { success = false, error = "no fusion-reactor on " .. surface.name } end
    local reading = {
        reactor_status = status_name(reactor.status),
        generator_status = {},
        success = true,
        entity_count = #surface.find_entities_filtered({}),
        generator_count = #generators,
        fuel_cells = reactor.get_item_count("fusion-power-cell"),
        coolant = 0,
        plasma_segment = 0,
        reactor_coolant_seg_visible = false,
        reactor_plasma_seg_visible = false,
        generator_plasma_seg_nil = true,
        generator_local_plasma = {},
        all_frozen = true,
        all_indestructible = true,
    }
    for i = 1, #reactor.fluidbox do
        local fluid = reactor.fluidbox[i]
        local seg_id = reactor.fluidbox.get_fluid_segment_id(i)
        if fluid and fluid.name == "fluoroketone-cold" then
            reading.coolant = reading.coolant + fluid.amount
            reading.reactor_coolant_seg_visible = seg_id ~= nil
        elseif fluid and fluid.name == "fusion-plasma" then
            reading.reactor_plasma_seg_visible = seg_id ~= nil
            if seg_id then
                local contents = reactor.fluidbox.get_fluid_segment_contents(i)
                reading.plasma_segment = (contents and contents["fusion-plasma"]) or 0
            else
                reading.plasma_segment = fluid.amount
            end
        end
    end
    for index, generator in ipairs(generators) do
        local seg_id = generator.fluidbox.get_fluid_segment_id(1)
        if seg_id ~= nil then reading.generator_plasma_seg_nil = false end
        local fluid = generator.fluidbox[1]
        reading.generator_local_plasma[index] = (fluid and fluid.name == "fusion-plasma" and fluid.amount) or 0
        reading.generator_status[index] = status_name(generator.status)
    end
    local frozen_set = { reactor }
    for _, generator in ipairs(generators) do frozen_set[#frozen_set + 1] = generator end
    for _, entity in ipairs(frozen_set) do
        if entity.active then reading.all_frozen = false end
        if entity.destructible then reading.all_indestructible = false end
    end
    return reading
end

if request.operation == "preflight" then
    return { success = true, tick = game.tick, paused = game.tick_paused }

elseif request.operation == "build_census_fusion" then
    if find_platform(FUSION_PLATFORM) then
        return { success = false, error = FUSION_PLATFORM .. " already exists — seed-prep refuses to rebuild" }
    end
    local platform = game.forces["player"].create_space_platform({
        name = FUSION_PLATFORM,
        planet = "nauvis",
        starter_pack = "space-platform-starter-pack",
    })
    if not platform then return { success = false, error = "create_space_platform returned nil" } end
    platform.apply_starter_pack()
    local surface = platform.surface
    if not surface then return { success = false, error = "platform has no surface after starter pack" } end
    -- UNPAUSED during ignition — the live-proven recipe (gallery HITL build 2026-07-18, 2.0.77)
    -- ran the reactor to full_output on an unpaused platform; the earlier paused-ignition attempt
    -- flowed plasma (generator in-transit stock) but never backed the segment up to parked stock.
    -- freeze_census_fusion pauses the platform at the end.
    platform.paused = false

    -- Foundation pad covering the fixture + temp power footprints.
    local tiles = {}
    for x = -10, 10 do
        for y = -12, 6 do
            local tile = surface.get_tile(x, y)
            if tile and tile.name ~= "space-platform-foundation" then
                tiles[#tiles + 1] = { name = "space-platform-foundation", position = { x = x, y = y } }
            end
        end
    end
    if #tiles > 0 then surface.set_tiles(tiles) end

    local reactor = surface.create_entity({
        name = "fusion-reactor", position = REACTOR_POSITION,
        direction = defines.direction.north, force = "player",
    })
    if not reactor then return { success = false, error = "fusion-reactor placement failed" } end
    local generators = {}
    for index, position in ipairs(GENERATOR_POSITIONS) do
        local generator = surface.create_entity({
            name = "fusion-generator", position = position,
            direction = defines.direction.north, force = "player",
        })
        if not generator then
            return { success = false, error = "fusion-generator " .. index .. " placement failed" }
        end
        generators[index] = generator
    end

    -- Fuel + coolant: input-side writes are accepted (only the plasma OUTPUT is engine-managed —
    -- Pitfall #21, fusion outputs are engine-managed; plasma itself must be GENERATED by running).
    reactor.insert({ name = "fusion-power-cell", count = 5 })
    local coolant_seeded = false
    for i = 1, #reactor.fluidbox do
        -- Find the coolant input purely by write-probe: attempt the write on each empty box and
        -- read back (no prototype/filter inspection is involved).
        if not reactor.fluidbox[i] then
            reactor.fluidbox[i] = { name = "fluoroketone-cold", amount = 1000 } -- FULL input: at ~10% fill the reactor throttles ~20x (measured 2026-07-18, 2.0.77; the live build parked plasma only after refilling to 1000)
            local written = reactor.fluidbox[i]
            if written and written.name == "fluoroketone-cold" then
                coolant_seeded = true
                break
            end
        end
    end
    if not coolant_seeded then return { success = false, error = "coolant write did not stick on any reactor input box" } end

    -- Temporary ignition power (removed at freeze): the platform network powers the reactor start.
    local power = surface.create_entity({
        name = "electric-energy-interface", position = TEMP_POWER_POSITION, force = "player",
    })
    if not power then return { success = false, error = "temporary electric-energy-interface placement failed" } end
    -- Temporary LOAD (removed at freeze): fusion generators only pull plasma when the network
    -- demands electricity, so a pure source is not enough to make the reactor flow plasma.
    local load = surface.create_entity({
        name = "electric-energy-interface", position = { x = TEMP_POWER_POSITION.x, y = TEMP_POWER_POSITION.y + 3 }, force = "player",
    })
    if not load then return { success = false, error = "temporary load electric-energy-interface placement failed" } end
    load.power_production = 0
    load.electric_buffer_size = 10000000
    -- Draw BELOW the generator's capacity: at full draw the plasma is consumed the tick it is
    -- produced and the segment stock measures 0; a partial draw lets the shared segment build the
    -- parked stock the fixture pins (the workhorse parks ~10 per segment under active flow).
    load.power_usage = 10000000 -- 10 MW

    return { success = true, entity_count = #surface.find_entities_filtered({}) }

elseif request.operation == "measure_census_fusion" then
    local platform = find_platform(FUSION_PLATFORM)
    if not platform then return { success = false, error = FUSION_PLATFORM .. " does not exist" } end
    return measure(platform.surface)

elseif request.operation == "park_census_fusion" then
    -- Park by removing the electric LOAD, leaving the generator ACTIVE but idle: with near-zero
    -- demand the reactor fills the shared segment to capacity and stalls at full_output — the
    -- measured workhorse steady state (reactors full_output, plasma 10/segment; live probe
    -- 2026-07-18, 2.0.77). Deactivating the generator instead BLOCKS the fill (measured on the
    -- same date/pin during seed-prep trial runs: segment stayed 0 with the consumer inactive).
    local platform = find_platform(FUSION_PLATFORM)
    if not platform then return { success = false, error = FUSION_PLATFORM .. " does not exist" } end
    local surface = platform.surface
    for _, temp in pairs(surface.find_entities_filtered({ name = "electric-energy-interface" })) do
        if temp.position.y > TEMP_POWER_POSITION.y + 1 then temp.destroy() end
    end
    return measure(surface)

elseif request.operation == "freeze_census_fusion" then
    local platform = find_platform(FUSION_PLATFORM)
    if not platform then return { success = false, error = FUSION_PLATFORM .. " does not exist" } end
    local surface = platform.surface
    local reactor, generators = fusion_entities(surface)
    if not reactor then return { success = false, error = "no fusion-reactor to freeze" } end
    local to_freeze = { reactor }
    for _, generator in ipairs(generators) do to_freeze[#to_freeze + 1] = generator end
    for _, entity in ipairs(to_freeze) do
        entity.active = false
        entity.destructible = false
    end
    -- The hub is part of the fixture census: indestructible too (corpus save-age law: paused
    -- platforms still take asteroid fire).
    local hub = surface.find_entities_filtered({ name = "space-platform-hub" })[1]
    if hub then hub.destructible = false end
    for _, temp in pairs(surface.find_entities_filtered({ name = "electric-energy-interface" })) do
        temp.destroy()
    end
    platform.paused = true
    return measure(surface)

elseif request.operation == "save" then
    if type(request.save_name) ~= "string" or request.save_name == "" then
        return { success = false, error = "save requires save_name" }
    end
    game.server_save(request.save_name)
    return { success = true, save_name = request.save_name }
end

return { success = false, error = "unknown operation " .. tostring(request.operation) }
