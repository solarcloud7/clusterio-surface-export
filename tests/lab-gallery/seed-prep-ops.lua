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

    local pos = { x = 98.5, y = 13.5 }
    local existing = s.find_entities_filtered({ name = "bulk-inserter", area = { { pos.x - 0.4, pos.y - 0.4 }, { pos.x + 0.4, pos.y + 0.4 } } })[1]
    if existing then existing.destroy() end
    local inserter = s.create_entity({ name = "bulk-inserter", position = pos, force = "player", quality = "legendary" })
    if not inserter then return { success = false, error = "legendary bulk-inserter placement failed" } end

    -- Seat 8 LEGENDARY railgun-ammo via a PLAIN held_stack.set_stack — NO active toggle (seating is
    -- activation-independent; inserter-lab B6). The raised bonus lets the whole 8 seat. The STACK
    -- quality is the fixture's quality-keyed adversarial dimension — the entity quality alone is not
    -- (B7 run 1b caught a normal-quality stack self-certified by an entity-quality read).
    inserter.held_stack.set_stack({ name = "railgun-ammo", count = 8, quality = "legendary" })
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
        quality = inserter.held_stack.quality and inserter.held_stack.quality.name or "normal",
        inserterQuality = inserter.quality.name,
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
    local inserter = s.find_entities_filtered({ name = "bulk-inserter", area = { { 98.5 - 0.4, 13.5 - 0.4 }, { 98.5 + 0.4, 13.5 + 0.4 } } })[1]
    if not inserter then return { success = false, error = "bulk-inserter not found at (98.5,13.5)" } end
    local held = inserter.held_stack
    return {
        success = true,
        heldCount = held.valid_for_read and held.count or 0,
        heldName = held.valid_for_read and held.name or nil,
        quality = (held.valid_for_read and held.quality) and held.quality.name or nil,
        inserterQuality = inserter.quality.name,
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

    local mpos = { x = 13.5, y = 27.5 }
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

    local ipos = { x = 16.5, y = 27.5 }
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
    local machine = s.find_entities_filtered({ name = "assembling-machine-1", area = { { 13.5 - 0.4, 27.5 - 0.4 }, { 13.5 + 0.4, 27.5 + 0.4 } } })[1]
    local inserter = s.find_entities_filtered({ name = "inserter", area = { { 16.5 - 0.4, 27.5 - 0.4 }, { 16.5 + 0.4, 27.5 + 0.4 } } })[1]
    if not machine then return { success = false, error = "assembling-machine-1 not found at (13.5,27.5)" } end
    if not inserter then return { success = false, error = "inserter not found at (16.5,27.5)" } end
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

elseif request.operation == "clear_legacy_strip" then
    -- Relocation prep (owner directive 2026-07-18, pads near the hub): the migrated-out legacy zone
    -- row left plain foundation tiles at y=-6..6, x=8..154 which the only-onto-empty stamp refuses.
    -- Clear ONLY plain space-platform-foundation tiles in that strip (pad template tiles are
    -- tutorial-grid/hazard — never plain foundation — so a re-run cannot eat a stamped pad), and
    -- drop the retired "[ PASTE TEST - empty pad ]" label. Idempotent.
    local platform = find_platform(OMNIBUS_PLATFORM)
    if not platform or not platform.surface then
        return { success = false, error = OMNIBUS_PLATFORM .. " not found for clear_legacy_strip" }
    end
    local s = platform.surface
    -- FAIL-SAFE: clearing foundation under live entities would destroy them — refuse unless the
    -- legacy zones are already migrated out (strip entity-free except relocated pads' own tiles,
    -- which are never plain foundation and never counted here).
    local strip_entities = 0
    for _, entity in ipairs(s.find_entities_filtered({ area = { { 8, -6 }, { 154, 6 } } })) do
        local tile = s.get_tile(math.floor(entity.position.x), math.floor(entity.position.y))
        if tile.name == "space-platform-foundation" then strip_entities = strip_entities + 1 end
    end
    if strip_entities > 0 then
        return { success = false, error = "REFUSED: " .. strip_entities .. " entities still stand on legacy-strip foundation — migrate the zones first" }
    end
    local cleared = {}
    for x = 8, 154 do
        for y = -6, 6 do
            if s.get_tile(x, y).name == "space-platform-foundation" then
                cleared[#cleared + 1] = { name = "empty-space", position = { x, y } }
            end
        end
    end
    if #cleared > 0 then s.set_tiles(cleared) end
    local labels_removed = 0
    for _, object in pairs(rendering.get_all_objects()) do
        if object.valid and object.surface == s and object.type == "text" then
            local t = object.text
            if type(t) == "table" then t = tostring(t[1] or "") end
            if tostring(t) == "[ PASTE TEST - empty pad ]" then
                object.destroy()
                labels_removed = labels_removed + 1
            end
        end
    end
    return { success = true, tiles_cleared = #cleared, labels_removed = labels_removed }

elseif request.operation == "relocate_pad" then
    -- Move one stamped pad (fixture content included) to a new origin near the hub. The NEW pad must
    -- already be stamped (stamp_test_cell runs first — it owns tiles, trio, card, name text); this op
    -- clones the INTERIOR entities across (exact state via clone_area), then destroys the old pad's
    -- entities, name text, and template tiles. Idempotent: old interior empty + new interior
    -- populated -> already_relocated; both empty -> skipped (a from-scratch seed migrates straight
    -- into the new pads).
    -- request: { name, old_origin_x, old_origin_y, new_origin_x, new_origin_y }
    local platform = find_platform(OMNIBUS_PLATFORM)
    if not platform or not platform.surface then
        return { success = false, error = OMNIBUS_PLATFORM .. " not found for relocate_pad" }
    end
    local s = platform.surface
    local sox, soy = request.old_origin_x, request.old_origin_y
    local nox, noy = request.new_origin_x, request.new_origin_y
    local function interior_of(px, py)
        local inside = {}
        for _, entity in ipairs(s.find_entities_filtered({ area = { { px, py }, { px + 13.5, py + 12 } } })) do
            local p = entity.position
            if p.x < px + 13.25 and p.y < py + 11.25 then inside[#inside + 1] = entity end
        end
        return inside
    end
    local old_interior = interior_of(sox, soy)
    local new_interior = interior_of(nox, noy)
    if #old_interior == 0 and #new_interior > 0 then
        return { success = true, already_relocated = true, dest_count = #new_interior }
    end
    if #old_interior == 0 then
        return { success = true, skipped = true, reason = "old pad empty; zone migration will fill the new pad directly" }
    end
    if #new_interior > 0 then
        return { success = false, error = "new pad at (" .. nox .. "," .. noy .. ") already holds " .. #new_interior .. " entities while the old pad still has " .. #old_interior }
    end

    -- Old TRIO + name text die first so the generous clone rectangle cannot duplicate them into the
    -- freshly stamped trio at the destination.
    for _, entity in ipairs(s.find_entities_filtered({ area = { { sox + 13, soy + 11 }, { sox + 16.5, soy + 12 } } })) do
        if entity.valid then entity.destroy({ raise_destroy = false }) end
    end
    for _, object in pairs(rendering.get_all_objects()) do
        if object.valid and object.surface == s and object.type == "text" then
            local target = object.target
            if target and target.position and target.position.x == sox + 6 and target.position.y == soy - 1.5 then
                object.destroy()
            end
        end
    end

    s.clone_area({
        source_area = { { sox, soy }, { sox + 16, soy + 12 } },
        destination_area = { { nox, noy }, { nox + 16, noy + 12 } },
        clone_tiles = false,
        clone_entities = true,
        clone_decoratives = false,
        clear_destination_entities = false,
        expand_map = true,
    })
    local moved = interior_of(nox, noy)
    if #moved ~= #old_interior then
        return { success = false, error = "relocate clone mismatch: old " .. #old_interior .. " vs new " .. #moved .. " — originals NOT destroyed" }
    end
    local destroyed = 0
    for _, entity in ipairs(old_interior) do
        if entity.valid then
            entity.destroy({ raise_destroy = false })
            destroyed = destroyed + 1
        end
    end
    -- Old template tiles (26x12 footprint) back to empty space.
    local tiles = {}
    for x = sox, sox + 25 do
        for y = soy, soy + 11 do
            if s.get_tile(x, y).name ~= "empty-space" then
                tiles[#tiles + 1] = { name = "empty-space", position = { x, y } }
            end
        end
    end
    if #tiles > 0 then s.set_tiles(tiles) end
    return { success = true, relocated = #moved, destroyed = destroyed, tiles_cleared = #tiles }

elseif request.operation == "read_ghost_proxy" then
    -- Read the ghosts-pad item-request-proxy's request payload (for hand-restoring the proxy on a
    -- transfer-delivered copy until the proxy transfer-loss bug is fixed). Read-only.
    local platform = find_platform(OMNIBUS_PLATFORM)
    if not platform or not platform.surface then
        return { success = false, error = OMNIBUS_PLATFORM .. " not found for read_ghost_proxy" }
    end
    local s = platform.surface
    local proxy = s.find_entities_filtered({ type = "item-request-proxy" })[1]
    if not proxy then return { success = false, error = "no item-request-proxy on the omnibus" } end
    local plans = {}
    for _, plan in ipairs(proxy.insert_plan or {}) do
        local counts = {}
        for _, spec in ipairs(plan.items and plan.items.in_inventory or {}) do
            counts[#counts + 1] = { inventory = spec.inventory, stack = spec.stack, count = spec.count or 1 }
        end
        plans[#plans + 1] = {
            name = plan.id and plan.id.name, quality = plan.id and plan.id.quality or "normal",
            in_inventory = counts,
        }
    end
    return { success = true, target = proxy.proxy_target and proxy.proxy_target.name,
        position = { x = proxy.position.x, y = proxy.position.y }, plans = plans }

elseif request.operation == "migrate_omnibus_zone" then
    -- Pad migration (owner directive 2026-07-18): move one legacy fixture zone from the y=0 row
    -- into a stamped test-foundation pad via surface.clone_area — the engine's exact-state copy
    -- (wires, ghosts, item-request-proxies, ground items, burner state, heat, crafting progress
    -- all ride), then destroy the originals and the old zone label. Idempotent: a zone already
    -- empty with a populated pad returns already_migrated.
    --
    -- request: { source_center_x, dest_origin_x, dest_origin_y, label }
    local platform = find_platform(OMNIBUS_PLATFORM)
    if not platform or not platform.surface then
        return { success = false, error = OMNIBUS_PLATFORM .. " not found for migrate_omnibus_zone" }
    end
    local s = platform.surface
    local cx = request.source_center_x
    local ox, oy = request.dest_origin_x, request.dest_origin_y
    local source_area = { { cx - 6, -6 }, { cx + 6, 6 } }
    -- Interior = the pad's copy window (run-tests.lua sweeps [ox+1,ox+13]x[oy,oy+12]); the clone
    -- rectangle is source-aligned so entity sub-tile fractions are preserved exactly.
    local dest_area = { { cx - 6 + (ox + 6 - cx), -6 + (oy + 6) }, { cx + 6 + (ox + 6 - cx), 6 + (oy + 6) } }
    local interior_area = { { ox, oy }, { ox + 13.5, oy + 12 } }
    -- The stamp's status trio lives ON the border row (y = oy+11.5, x >= ox+13.5); count only
    -- entities whose POSITION is inside the copy window so the trio never reads as pad content.
    local function interior_entities()
        local inside = {}
        for _, entity in ipairs(s.find_entities_filtered({ area = interior_area })) do
            local p = entity.position
            if p.x < ox + 13.25 and p.y < oy + 11.25 then inside[#inside + 1] = entity end
        end
        return inside
    end

    local source_entities = s.find_entities_filtered({ area = source_area })
    local dest_before = interior_entities()
    if #source_entities == 0 and #dest_before > 0 then
        return { success = true, already_migrated = true, dest_count = #dest_before }
    end
    if #source_entities == 0 then
        return { success = false, error = "zone at x=" .. tostring(cx) .. " is empty and pad is empty — nothing to migrate" }
    end
    if #dest_before > 0 then
        return { success = false, error = "pad interior at (" .. ox .. "," .. oy .. ") already holds " .. #dest_before .. " entities while the zone still has " .. #source_entities }
    end

    s.clone_area({
        source_area = source_area,
        destination_area = dest_area,
        clone_tiles = false,
        clone_entities = true,
        clone_decoratives = false,
        clear_destination_entities = false,
        expand_map = true,
    })
    local dest_after = interior_entities()
    if #dest_after ~= #source_entities then
        return { success = false, error = "clone count mismatch: source " .. #source_entities .. " vs pad " .. #dest_after .. " — originals NOT destroyed" }
    end

    -- Destroy the originals (spider legs die with their spidertron; proxies with their target —
    -- re-check validity as we sweep) and the old zone label text.
    local destroyed = 0
    for _, entity in ipairs(source_entities) do
        if entity.valid then
            entity.destroy({ raise_destroy = false })
            destroyed = destroyed + 1
        end
    end
    local leftovers = s.find_entities_filtered({ area = source_area })
    if #leftovers > 0 then
        return { success = false, error = tostring(#leftovers) .. " source entities survived destroy at zone x=" .. tostring(cx) }
    end
    local labels_removed = 0
    if request.label then
        for _, object in pairs(rendering.get_all_objects()) do
            if object.surface == s and object.type == "text" then
                local t = object.text
                if type(t) == "table" then t = tostring(t[1] or "") end
                if tostring(t) == request.label then
                    object.destroy()
                    labels_removed = labels_removed + 1
                end
            end
        end
    end
    return { success = true, migrated = #dest_after, destroyed = destroyed, labels_removed = labels_removed }

elseif request.operation == "survey_omnibus" then
    -- Recon for the pad migration: every rendering text and every entity (name, type, position)
    -- on the golden omnibus platform, so the legacy fixture zones can be mapped from the repo
    -- without hand-flying the world. Read-only.
    local platform = find_platform(OMNIBUS_PLATFORM)
    if not platform or not platform.surface then
        return { success = false, error = OMNIBUS_PLATFORM .. " not found for survey_omnibus" }
    end
    local s = platform.surface
    local texts = {}
    for _, object in pairs(rendering.get_all_objects()) do
        if object.surface == s and object.type == "text" then
            local t = object.text
            if type(t) == "table" then t = tostring(t[1] or "") end
            texts[#texts + 1] = { text = tostring(t), x = object.target.position.x, y = object.target.position.y }
        end
    end
    local entities = {}
    for _, entity in ipairs(s.find_entities_filtered({})) do
        entities[#entities + 1] = { name = entity.name, type = entity.type,
            x = entity.position.x, y = entity.position.y }
    end
    return { success = true, surface = s.name, texts = texts, entities = entities,
        entity_count = #entities }
end

return { success = false, error = "unknown operation " .. tostring(request.operation) }
