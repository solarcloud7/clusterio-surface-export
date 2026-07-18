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
-- The two ported fixtures ride the EXISTING golden omnibus (lab-omnibus-state-v1, NOT the live design
-- world lab-omnibus-platform-v1). The seed must already carry it; the build ops fail loud if absent.
local OMNIBUS_PLATFORM = "lab-omnibus-state-v1"

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
    -- The parked stock can sit REACTOR-side (live full_output steady state) or GENERATOR-side
    -- (isolated-run steady state, measured 2026-07-18, 2.0.77: gen local 9.13 while the reactor
    -- box read empty) — either way it is the fixture's plasma; report the larger reading.
    for _, amount in ipairs(reading.generator_local_plasma) do
        if amount > reading.plasma_segment then reading.plasma_segment = amount end
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

elseif request.operation == "stamp_test_cell" then
    -- Stamp a test-foundation cell (tile template + status-runner trio + name text) onto the golden
    -- omnibus, replicating test-foundation.mjs's stamp: only-onto-empty tile refusal + idempotent
    -- re-stamp. The tile TEMPLATE (rows + legend) is passed in from ONE source (test-foundation.mjs);
    -- the card text is passed in from ONE source (manifest.json testCard).
    local ox = math.floor(request.origin_x)
    local oy = math.floor(request.origin_y)
    local rows = request.rows
    local legend = request.legend
    local card = request.card or {}
    if type(rows) ~= "table" or type(legend) ~= "table" then
        return { success = false, error = "stamp_test_cell requires rows and legend tables" }
    end
    local platform = find_platform(OMNIBUS_PLATFORM)
    if not platform or not platform.surface then
        return { success = false, error = OMNIBUS_PLATFORM .. " not found for stamp_test_cell" }
    end
    local s = platform.surface

    -- Tile stamp: only-onto-empty refusal + idempotent re-stamp (matches test-foundation.mjs).
    local tiles, mismatch, already = {}, 0, 0
    for r = 1, #rows do
        local row = rows[r]
        for c = 1, #row do
            local ch = string.sub(row, c, c)
            local want = legend[ch]
            if want then
                local x, y = ox + c - 1, oy + r - 1
                local cur = s.get_tile(x, y).name
                if cur == want then already = already + 1
                elseif cur == "empty-space" then tiles[#tiles + 1] = { name = want, position = { x, y } }
                else mismatch = mismatch + 1 end
            end
        end
    end
    if mismatch > 0 then
        return { success = false, error = "REFUSED: " .. mismatch .. " target tile(s) hold foreign tiles (only-onto-empty rule)" }
    end
    if #tiles > 0 then s.set_tiles(tiles) end

    -- Trio member 1: description display-panel on the bottom border at origin+(13.5,11.5), carrying the
    -- LAW/ACTION/EXPECT/FORBIDDEN card text (real content substituted). Find-or-create for idempotency.
    local dpx, dpy = ox + 13.5, oy + 11.5
    local desc = s.find_entities_filtered({ name = "display-panel", area = { { dpx - 0.4, dpy - 0.4 }, { dpx + 0.4, dpy + 0.4 } } })[1]
    if not desc then desc = s.create_entity({ name = "display-panel", position = { dpx, dpy }, force = "player" }) end
    if not desc then return { success = false, error = "description display-panel placement failed" } end
    local function card_field(field) return tostring(card[field] or "") end
    desc.display_panel_text = "LAW: \n" .. card_field("law") .. "\n\nACTION: \n" .. card_field("action")
        .. "\n\nEXPECT: \n" .. card_field("expect") .. "\n\nFORBIDDEN: \n" .. card_field("forbidden")

    -- Trio member 2: constant-combinator at origin+(14.5,11.5) with TWO logistic sections (signal-check,
    -- signal-deny), BOTH inactive (the waiting state). Section 1 exists by default; add a second.
    local ccx, ccy = ox + 14.5, oy + 11.5
    local comb = s.find_entities_filtered({ name = "constant-combinator", area = { { ccx - 0.4, ccy - 0.4 }, { ccx + 0.4, ccy + 0.4 } } })[1]
    if not comb then comb = s.create_entity({ name = "constant-combinator", position = { ccx, ccy }, force = "player" }) end
    if not comb then return { success = false, error = "constant-combinator placement failed" } end
    local cb = comb.get_or_create_control_behavior()
    local section1 = cb.sections[1] or cb.add_section()
    local section2 = cb.sections[2] or cb.add_section()
    section1.filters = { { value = { type = "virtual", name = "signal-check", quality = "normal", comparator = "=" }, min = 1 } }
    section2.filters = { { value = { type = "virtual", name = "signal-deny", quality = "normal", comparator = "=" }, min = 1 } }
    section1.active = false
    section2.active = false

    -- Trio member 3: status display-panel at origin+(15.5,11.5), RED-wired to the combinator, whose
    -- control-behavior messages render Success on signal-check, Failure on signal-deny, else a waiting
    -- clock. Find-or-create; connect_to on an already-connected wire is a no-op (idempotent).
    local spx, spy = ox + 15.5, oy + 11.5
    local status = s.find_entities_filtered({ name = "display-panel", area = { { spx - 0.4, spy - 0.4 }, { spx + 0.4, spy + 0.4 } } })[1]
    if not status then status = s.create_entity({ name = "display-panel", position = { spx, spy }, force = "player" }) end
    if not status then return { success = false, error = "status display-panel placement failed" } end
    status.get_wire_connector(defines.wire_connector_id.circuit_red, true).connect_to(comb.get_wire_connector(defines.wire_connector_id.circuit_red, true))
    status.get_or_create_control_behavior().messages = {
        { icon = { type = "virtual", name = "signal-check" }, text = "Success", condition = { first_signal = { type = "virtual", name = "signal-check" }, comparator = ">", constant = 0 } },
        { icon = { type = "virtual", name = "signal-alert" }, text = "Failure {failure-message}", condition = { first_signal = { type = "virtual", name = "signal-deny" }, comparator = ">", constant = 0 } },
        { icon = { type = "virtual", name = "signal-clock" }, condition = { first_signal = { type = "virtual", name = "signal-everything" }, comparator = "=", constant = 0 } },
    }

    -- Name rendering text above the pad at origin+(6,-1.5), scale 2.5, waiting-blue. Idempotent: skip if
    -- a text object already targets this position on this surface (test-foundation redraws; we don't).
    local tx, ty = ox + 6, oy - 1.5
    local has_name = false
    for _, object in pairs(rendering.get_all_objects("")) do
        if object.valid and object.type == "text" and object.surface == s then
            local target = object.target
            if target and target.position and target.position.x == tx and target.position.y == ty then
                has_name = true
                break
            end
        end
    end
    if not has_name then
        rendering.draw_text({ text = request.name or "", surface = s, target = { tx, ty }, scale = 2.5, color = { r = 0.3, g = 0.85, b = 1, a = 1 } })
    end

    return {
        success = true, origin = { ox, oy }, name = request.name,
        wrote = #tiles, already = already,
        panel = desc ~= nil, combinator = comb ~= nil, status = status ~= nil,
    }

elseif request.operation == "build_inserter_held" then
    local platform = find_platform(OMNIBUS_PLATFORM)
    if not platform or not platform.surface then
        return { success = false, error = OMNIBUS_PLATFORM .. " not found for build_inserter_held" }
    end
    local s = platform.surface
    local force = game.forces["player"]

    -- OWNER-APPROVED baked global state: RAISE the player force bulk-inserter capacity bonus to >= 11
    -- (raise-only; never lower) so the legendary hand can physically seat 8 railgun-ammo (Pitfall #29,
    -- dest-force research governs held capacity). Record before/after and log the raise.
    local bonus_before = force.bulk_inserter_capacity_bonus
    if bonus_before < 11 then
        force.bulk_inserter_capacity_bonus = 11
        log(string.format("[seed-prep] raised player.bulk_inserter_capacity_bonus %s -> 11 for inserter-held-capacity fixture", tostring(bonus_before)))
    end
    local bonus_after = force.bulk_inserter_capacity_bonus

    local pos = { x = 40.5, y = -122.5 }
    local existing = s.find_entities_filtered({ name = "bulk-inserter", area = { { pos.x - 0.4, pos.y - 0.4 }, { pos.x + 0.4, pos.y + 0.4 } } })[1]
    if existing then existing.destroy() end
    local inserter = s.create_entity({ name = "bulk-inserter", position = pos, force = "player", quality = "legendary" })
    if not inserter then return { success = false, error = "legendary bulk-inserter placement failed" } end

    -- Seat 8 railgun-ammo via a PLAIN held_stack.set_stack — NO active toggle (seating is
    -- activation-independent; inserter-lab B6). The raised bonus lets the whole 8 seat.
    inserter.held_stack.set_stack({ name = "railgun-ammo", count = 8 })
    local seated = inserter.held_stack.valid_for_read and inserter.held_stack.count or 0
    if seated ~= 8 then
        return { success = false, error = "held hand seated " .. tostring(seated) .. " railgun-ammo, expected 8 (force bonus " .. tostring(bonus_after) .. ")" }
    end
    inserter.active = false
    inserter.destructible = false

    return {
        success = true,
        heldCount = inserter.held_stack.count,
        heldName = inserter.held_stack.name,
        quality = inserter.quality.name,
        active = inserter.active,
        destructible = inserter.destructible,
        forceBulkBonus = bonus_after,
        bonusBefore = bonus_before,
    }

elseif request.operation == "measure_inserter_held" then
    local platform = find_platform(OMNIBUS_PLATFORM)
    if not platform or not platform.surface then
        return { success = false, error = OMNIBUS_PLATFORM .. " not found for measure_inserter_held" }
    end
    local s = platform.surface
    local inserter = s.find_entities_filtered({ name = "bulk-inserter", area = { { 40.5 - 0.4, -122.5 - 0.4 }, { 40.5 + 0.4, -122.5 + 0.4 } } })[1]
    if not inserter then return { success = false, error = "bulk-inserter not found at (40.5,-122.5)" } end
    local held = inserter.held_stack
    return {
        success = true,
        heldCount = held.valid_for_read and held.count or 0,
        heldName = held.valid_for_read and held.name or nil,
        quality = inserter.quality.name,
        active = inserter.active,
        destructible = inserter.destructible,
        forceBulkBonus = game.forces["player"].bulk_inserter_capacity_bonus,
    }

elseif request.operation == "build_no_tick_pair" then
    local platform = find_platform(OMNIBUS_PLATFORM)
    if not platform or not platform.surface then
        return { success = false, error = OMNIBUS_PLATFORM .. " not found for build_no_tick_pair" }
    end
    local s = platform.surface

    local mpos = { x = 39.5, y = -108.5 }
    local existing_machine = s.find_entities_filtered({ name = "assembling-machine-1", area = { { mpos.x - 0.4, mpos.y - 0.4 }, { mpos.x + 0.4, mpos.y + 0.4 } } })[1]
    if existing_machine then existing_machine.destroy() end
    local machine = s.create_entity({ name = "assembling-machine-1", position = mpos, force = "player" })
    if not machine then return { success = false, error = "assembling-machine-1 placement failed" } end
    machine.set_recipe("iron-gear-wheel")
    local input = machine.get_inventory(defines.inventory.crafter_input)
    if not input then return { success = false, error = "assembling-machine-1 has no crafter_input inventory" } end
    input.insert({ name = "iron-plate", count = 4 })

    -- Write-assert the mid-craft progress: read back within a crafting-progress ULP or fail loud.
    machine.crafting_progress = 0.42
    local read_back = machine.crafting_progress
    if math.abs(read_back - 0.42) > 1e-9 then
        return { success = false, error = "crafting_progress write-assert failed: read " .. tostring(read_back) .. " expected 0.42" }
    end
    machine.active = false
    machine.destructible = false

    local ipos = { x = 42.5, y = -108.5 }
    local existing_inserter = s.find_entities_filtered({ name = "inserter", area = { { ipos.x - 0.4, ipos.y - 0.4 }, { ipos.x + 0.4, ipos.y + 0.4 } } })[1]
    if existing_inserter then existing_inserter.destroy() end
    local inserter = s.create_entity({ name = "inserter", position = ipos, direction = defines.direction.west, force = "player" })
    if not inserter then return { success = false, error = "inserter placement failed" } end
    inserter.active = false
    inserter.destructible = false

    local recipe = machine.get_recipe()
    return {
        success = true,
        progress = machine.crafting_progress,
        recipe = recipe and recipe.name or nil,
        inputPlates = input.get_item_count("iron-plate"),
        assemblerActive = machine.active,
        inserterActive = inserter.active,
        inserterHandEmpty = not inserter.held_stack.valid_for_read,
        allIndestructible = (not machine.destructible) and (not inserter.destructible),
    }

elseif request.operation == "measure_no_tick_pair" then
    local platform = find_platform(OMNIBUS_PLATFORM)
    if not platform or not platform.surface then
        return { success = false, error = OMNIBUS_PLATFORM .. " not found for measure_no_tick_pair" }
    end
    local s = platform.surface
    local machine = s.find_entities_filtered({ name = "assembling-machine-1", area = { { 39.5 - 0.4, -108.5 - 0.4 }, { 39.5 + 0.4, -108.5 + 0.4 } } })[1]
    local inserter = s.find_entities_filtered({ name = "inserter", area = { { 42.5 - 0.4, -108.5 - 0.4 }, { 42.5 + 0.4, -108.5 + 0.4 } } })[1]
    if not machine then return { success = false, error = "assembling-machine-1 not found at (39.5,-108.5)" } end
    if not inserter then return { success = false, error = "inserter not found at (42.5,-108.5)" } end
    local input = machine.get_inventory(defines.inventory.crafter_input)
    local recipe = machine.get_recipe()
    return {
        success = true,
        progress = machine.crafting_progress,
        recipe = recipe and recipe.name or nil,
        inputPlates = input and input.get_item_count("iron-plate") or nil,
        assemblerActive = machine.active,
        inserterActive = inserter.active,
        inserterHandEmpty = not inserter.held_stack.valid_for_read,
        allIndestructible = (not machine.destructible) and (not inserter.destructible),
    }
end

return { success = false, error = "unknown operation " .. tostring(request.operation) }
