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

-- Verify-not-construct: the corpus is hand-curated in the seed. These helpers physically MEASURE
-- each baked fixture and never build or mutate it.
local function surface_for_platform(name)
    for _, platform in pairs(game.forces.player.platforms) do
        if platform.valid and platform.name == name then return platform.surface, platform end
    end
    return nil, nil
end

local function at(surface, name, x, y)
    return surface.find_entities_filtered({ name = name, area = { { x - 0.6, y - 0.6 }, { x + 0.6, y + 0.6 } } })[1]
end

-- Measure anchors come from manifest.json fixture `anchors` (single source of truth). The
-- literal-coordinate duplication between this file and reload-meter.cjs cost a bake cycle during
-- the pad migration (2026-07-18: one meter updated, the other not — verify-save went red on the
-- stale copy); both meters now read the same manifest field. Fail-loud on any missing entry.
local function anchor_lookup(manifest, fixture_id)
    for _, fixture in ipairs(manifest and manifest.fixtures or {}) do
        if fixture.id == fixture_id then
            local anchors = assert(fixture.anchors, fixture_id .. " manifest entry has no anchors")
            return function(entity_name)
                for _, a in ipairs(anchors) do
                    if a.entity == entity_name then return a.x, a.y end
                end
                error(fixture_id .. " manifest anchors missing entity " .. entity_name)
            end
        end
    end
    error("manifest fixture missing: " .. tostring(fixture_id))
end

local function anchored(surface, anchor, entity_name, label)
    local x, y = anchor(entity_name)
    return assert(at(surface, entity_name, x, y),
        label .. " " .. entity_name .. " missing at (" .. x .. "," .. y .. ")")
end

local function measure_omnibus_adversarial(surface, anchor)
    local chest = anchored(surface, anchor, "steel-chest", "omnibus adversarial")
    local inv = chest.get_inventory(defines.inventory.chest)
    local armor
    for i = 1, #inv do local s = inv[i] if s.valid_for_read and s.name == "power-armor-mk2" then armor = s break end end
    armor = assert(armor, "omnibus adversarial power-armor-mk2 missing")
    local r = {}
    for _, eq in ipairs(armor.grid.equipment) do
        if eq.name == "battery-mk2-equipment" then r.battEnergy = eq.energy r.battQuality = eq.quality.name end
        if eq.name == "energy-shield-mk2-equipment" then r.shieldValue = eq.shield r.shieldMax = eq.max_shield r.shieldQuality = eq.quality.name end
    end
    local m = anchored(surface, anchor, "assembling-machine-2", "omnibus adversarial")
    local recipe, quality = m.get_recipe()
    r.recipe = recipe and recipe.name or nil
    r.recipeQuality = quality and quality.name or nil
    return r
end

local function measure_omnibus_latch(surface, anchor)
    local d = anchored(surface, anchor, "decider-combinator", "omnibus latch")
    local net = d.get_circuit_network(defines.wire_connector_id.combinator_output_red)
    return { signalS = net and net.get_signal({ type = "virtual", name = "signal-S" }) or nil }
end

local function measure_omnibus_midcraft(surface, anchor)
    local m = anchored(surface, anchor, "assembling-machine-1", "omnibus midcraft")
    local inv = m.get_inventory(defines.inventory.assembling_machine_input)
    return { progress = m.crafting_progress, active = m.active, inputPlates = inv and inv.get_item_count("iron-plate") or nil }
end

local function measure_omnibus_burner(surface, anchor)
    local bi = anchored(surface, anchor, "burner-inserter", "omnibus burner")
    local fi = bi.get_inventory(defines.inventory.fuel)
    return {
        coal = fi and fi.get_item_count("coal") or nil,
        active = bi.active,
        burning = bi.burner and bi.burner.currently_burning and bi.burner.currently_burning.name.name or nil,
        remaining = bi.burner and bi.burner.remaining_burning_fuel or nil,
    }
end

local function measure_omnibus_equipment(surface, anchor)
    local s = anchored(surface, anchor, "spidertron", "omnibus equipment")
    local r = { holder = "spidertron" }
    for _, eq in ipairs(s.grid.equipment) do
        if eq.name == "battery-mk2-equipment" then r.battEnergy = eq.energy r.battMax = eq.max_energy end
    end
    return r
end

local function measure_omnibus_circuit(surface, anchor)
    local cc = anchored(surface, anchor, "constant-combinator", "omnibus circuit")
    local behavior = cc.get_control_behavior()
    local r = {}
    local section = behavior.sections and behavior.sections[1]
    if section then
        local filter = section.filters and section.filters[1]
        if filter then r.constantSignal = filter.value and filter.value.name or nil r.constantMin = filter.min end
    end
    local lamp = anchored(surface, anchor, "small-lamp", "omnibus circuit")
    local lb = lamp.get_control_behavior()
    -- Explicit if: `lb and lb.use_colors or nil` would collapse a legitimate `false` reading to nil,
    -- silently dropping the boolean from certification (the false-collapsing and/or idiom).
    if lb then r.lampUseColors = lb.use_colors end
    return r
end

local function measure_omnibus_bonus(surface, anchor)
    local m = anchored(surface, anchor, "assembling-machine-2", "omnibus bonus")
    local mi = m.get_module_inventory()
    return { bonusProgress = m.bonus_progress, modules = mi and mi.get_item_count("productivity-module") or nil, active = m.active }
end

local function measure_omnibus_fluids(surface, anchor)
    local r = {}
    local tank = anchored(surface, anchor, "storage-tank", "omnibus fluids")
    if tank.fluidbox[1] then r.steam = tank.fluidbox[1].amount r.steamTemp = tank.fluidbox[1].temperature end
    local chem = anchored(surface, anchor, "chemical-plant", "omnibus fluids")
    for i = 1, #chem.fluidbox do
        local f = chem.fluidbox[i]
        if f then if f.name == "water" then r.chemWater = f.amount elseif f.name == "petroleum-gas" then r.chemGas = f.amount end end
    end
    local foundry = anchored(surface, anchor, "foundry", "omnibus fluids")
    for i = 1, #foundry.fluidbox do
        local f = foundry.fluidbox[i]
        if f and f.name == "molten-iron" then r.foundryMolten = f.amount r.foundryTemp = f.temperature end
    end
    return r
end

local function measure_omnibus_ghosts(surface)
    local entity_ghosts = surface.find_entities_filtered({ type = "entity-ghost" })
    return {
        entityGhosts = #entity_ghosts,
        tileGhosts = #surface.find_entities_filtered({ type = "tile-ghost" }),
        proxies = #surface.find_entities_filtered({ type = "item-request-proxy" }),
        ghostInner = entity_ghosts[1] and entity_ghosts[1].ghost_name or nil,
    }
end

local function measure_omnibus_ground(surface)
    local total = 0
    for _, e in pairs(surface.find_entities_filtered({ type = "item-entity" })) do
        local stack = e.stack
        if stack and stack.valid_for_read and stack.name == "iron-plate" then total = total + stack.count end
    end
    return { ironPlate = total }
end

local function measure_omnibus_schedule(platform)
    local schedule = platform.get_schedule()
    local records = schedule.get_records()
    local interrupts = schedule.get_interrupts()
    return { records = #records, interrupts = #interrupts, interruptName = interrupts[1] and interrupts[1].name or nil }
end

local function measure_energy(surface)
    local acc = surface.find_entities_filtered({ type = "accumulator" })[1]
    local electric = 0
    for _, e in pairs(surface.find_entities_filtered({})) do
        if e.type ~= "space-platform-hub" and e.prototype.electric_energy_source_prototype then electric = electric + 1 end
    end
    return {
        accEnergy = acc and acc.energy or nil,
        accName = acc and acc.name or nil,
        electricEntities = electric,
        entities = #surface.find_entities_filtered({}),
    }
end

local function measure_belt_corner(surface)
    local belts = surface.find_entities_filtered({ type = "transport-belt" })
    local total = 0
    for _, b in ipairs(belts) do
        for line_index = 1, b.get_max_transport_line_index() do
            for _, row in ipairs(b.get_transport_line(line_index).get_detailed_contents()) do total = total + row.stack.count end
        end
    end
    local corner = surface.find_entity("turbo-transport-belt", { 16.5, 0.5 })
    local inside = corner and corner.get_transport_line(1) or nil
    local inside_count = 0
    if inside then for _, row in ipairs(inside.get_detailed_contents()) do inside_count = inside_count + row.stack.count end end
    return {
        beltCount = #belts,
        totalIron = total,
        cornerShape = corner and corner.belt_shape or nil,
        cornerX = corner and corner.position.x or nil,
        cornerY = corner and corner.position.y or nil,
        insideItems = inside_count,
        insideLength = inside and inside.line_length or nil,
        entities = #surface.find_entities_filtered({}),
    }
end

-- Ported onto the golden omnibus (lab-omnibus-state-v1) by seed-prep-ops.lua; these read the SAME
-- fields the seed-prep build/measure recorded, so the fingerprint gate is symmetric.
local function measure_inserter_held(surface, anchor)
    local inserter = anchored(surface, anchor, "bulk-inserter", "inserter-held")
    local held = inserter.held_stack
    return {
        heldCount = held.valid_for_read and held.count or 0,
        heldName = held.valid_for_read and held.name or nil,
        -- STACK quality, not entity quality (the entity-quality read self-certified a normal stack
        -- as legendary once — B7 run 1b, 2026-07-18).
        quality = (held.valid_for_read and held.quality) and held.quality.name or nil,
        active = inserter.active,
        destructible = inserter.destructible,
        forceBulkBonus = game.forces.player.bulk_inserter_capacity_bonus,
    }
end

local function measure_no_tick_pair(surface, anchor)
    local machine = anchored(surface, anchor, "assembling-machine-1", "no-tick")
    local inserter = anchored(surface, anchor, "inserter", "no-tick")
    local input = machine.get_inventory(defines.inventory.crafter_input)
    local recipe = machine.get_recipe()
    return {
        progress = machine.crafting_progress,
        recipe = recipe and recipe.name or nil,
        inputPlates = input and input.get_item_count("iron-plate") or nil,
        assemblerActive = machine.active,
        inserterActive = inserter.active,
        inserterHandEmpty = not inserter.held_stack.valid_for_read,
        allIndestructible = (not machine.destructible) and (not inserter.destructible),
    }
end

local function measure_repin_beacon(surface, anchor)
    -- engine-repin B8 fixture (beacon crafting_speed same-execution propagation; distinct from
    -- no-tick-sync B8): baked as an ACTIVE empty-module beacon beside a frozen recipe-set crafter.
    local beacon = anchored(surface, anchor, "beacon", "repin beacon")
    local machine = anchored(surface, anchor, "assembling-machine-2", "repin beacon")
    local modules = beacon.get_inventory(defines.inventory.beacon_modules)
    return {
        machineSpeed = machine.crafting_speed,
        beaconModulesEmpty = modules ~= nil and modules.is_empty(),
        beaconActive = beacon.active,
        machineActive = machine.active,
        allIndestructible = (not beacon.destructible) and (not machine.destructible),
    }
end

-- Measure the full baked corpus keyed by manifest fixture id. Locators are code; expected values
-- come from the manifest fingerprints (single source of truth). Each measurement is pcall-guarded
-- and SURFACES its error (never swallows) so a mid-deletion destination poll cannot abort inspect
-- while a normalize-time locator failure still fails the gate loudly.
local function measure_census_fusion(surface)
    local reactor = assert(at(surface, "fusion-reactor", 0, 0), "census-fusion reactor missing")
    local generator = assert(at(surface, "fusion-generator", 0.5, -5.5), "census-fusion generator missing")
    local r = {
        entities = #surface.find_entities_filtered({}),
        generatorCount = #surface.find_entities_filtered({ name = "fusion-generator" }),
        fuelCells = reactor.get_item_count("fusion-power-cell"),
        coolant = 0, plasmaSegment = 0,
        reactorCoolantSegVisible = false, reactorPlasmaSegVisible = false,
        generatorPlasmaSegNil = generator.fluidbox.get_fluid_segment_id(1) == nil,
        allFrozen = (not reactor.active) and (not generator.active),
        allIndestructible = (not reactor.destructible) and (not generator.destructible),
    }
    for i = 1, #reactor.fluidbox do
        local f = reactor.fluidbox[i]
        local sid = reactor.fluidbox.get_fluid_segment_id(i)
        if f and f.name == "fluoroketone-cold" then
            r.coolant = r.coolant + f.amount
            r.reactorCoolantSegVisible = sid ~= nil
        elseif f and f.name == "fusion-plasma" then
            r.reactorPlasmaSegVisible = sid ~= nil
            if f.amount > r.plasmaSegment then r.plasmaSegment = f.amount end
        end
    end
    -- Parked stock can sit generator-side (isolated steady state) — report the larger reading.
    local gf = generator.fluidbox[1]
    if gf and gf.name == "fusion-plasma" and gf.amount > r.plasmaSegment then r.plasmaSegment = gf.amount end
    return r
end

local function measure_corpus(manifest)
    local out = {}
    local function safe(id, fn)
        local ok, result = pcall(fn)
        if ok then out[id] = result else out[id] = { error = tostring(result) } end
    end
    -- Anchored measures resolve their coordinates from the manifest INSIDE the pcall, so a
    -- missing/incomplete anchors entry fails that fixture loudly instead of aborting the sweep.
    local function anchored_safe(id, fn)
        safe(id, function() return fn(anchor_lookup(manifest, id)) end)
    end
    local omni, omni_platform = surface_for_platform("lab-omnibus-state-v1")
    if omni then
        anchored_safe("omnibus-adversarial-inventory", function(a) return measure_omnibus_adversarial(omni, a) end)
        anchored_safe("omnibus-heat-temperature", function(a) return { temperature = anchored(omni, a, "heat-pipe", "omnibus heat").temperature } end)
        anchored_safe("omnibus-decider-latch", function(a) return measure_omnibus_latch(omni, a) end)
        anchored_safe("omnibus-midcraft-progress", function(a) return measure_omnibus_midcraft(omni, a) end)
        anchored_safe("omnibus-burner-fuel", function(a) return measure_omnibus_burner(omni, a) end)
        anchored_safe("omnibus-equipment-grid", function(a) return measure_omnibus_equipment(omni, a) end)
        anchored_safe("omnibus-circuit-config", function(a) return measure_omnibus_circuit(omni, a) end)
        anchored_safe("omnibus-module-bonus-progress", function(a) return measure_omnibus_bonus(omni, a) end)
        anchored_safe("omnibus-crafting-fluids", function(a) return measure_omnibus_fluids(omni, a) end)
        safe("omnibus-ghosts-and-proxies", function() return measure_omnibus_ghosts(omni) end)
        safe("omnibus-ground-items", function() return measure_omnibus_ground(omni) end)
        safe("omnibus-platform-schedule", function() return measure_omnibus_schedule(omni_platform) end)
        anchored_safe("inserter-held-capacity", function(a) return measure_inserter_held(omni, a) end)
        anchored_safe("no-tick-sync-frozen-pair", function(a) return measure_no_tick_pair(omni, a) end)
        anchored_safe("repin-beacon-speed", function(a) return measure_repin_beacon(omni, a) end)
    end
    local energy = surface_for_platform("lab-energy-v1")
    if energy then safe("energy-accumulator-drain", function() return measure_energy(energy) end) end
    local corner = surface_for_platform("lab-belt-corner-v1")
    if corner then safe("belt-corner-recovery", function() return measure_belt_corner(corner) end) end
    local workhorse = surface_for_platform("lab-transfer-fixture-v1")
    if workhorse then safe("transfer-workhorse", function() return { entities = #workhorse.find_entities_filtered({}) } end) end
    local fusion = surface_for_platform("lab-census-fusion-v1")
    if fusion then safe("census-fusion-shared-plasma", function() return measure_census_fusion(fusion) end) end
    for n = 1, 3 do
        local consumable = surface_for_platform("lab-consumable-" .. n)
        if consumable then safe("consumable-hub-" .. n, function() return { entities = #consumable.find_entities_filtered({}) } end) end
    end
    return out
end

-- ONLY the crafting-progress and module-bonus-progress doubles absorb a sub-ULP save/load drift;
-- every OTHER fingerprint field (integer counts, temperatures, energies, fluid amounts, coordinates,
-- strings, booleans) is compared with exact equality. The 1e-9 tolerance is never applied blanket.
local tolerant_double_fields = { progress = true, bonusProgress = true }

local function approx_equal(key, a, b)
    if tolerant_double_fields[key] and type(a) == "number" and type(b) == "number" then
        return math.abs(a - b) <= 1e-9
    end
    return a == b
end

-- Fixtures measured by a SEPARATE physical path (not measure_corpus): the corpus gate must not
-- expect them among the measured set. This is an EXPLICIT allowlist with reasons — never an
-- absence-skip: any OTHER manifest fixture missing from the measured set fails the gate loudly.
local corpus_excluded = {
    ["belt-5x5-125-unstacked"] = "belt pilot asserted by the belt census (beltFixtureExact)",
    ["specialized-fluid-reachability"] = "drill asserted by the reachability block (reachabilityFixtureExact)",
}

-- Fail-loud gate: every non-excluded manifest fixture MUST have a measurement, and every declared
-- fingerprint field must be present and exactly equal. A missing fixture, a measurement error, a
-- dropped/drifted field, an unexpected measured id, or an empty roster all fail loudly — the gate is
-- unsatisfiable by omission.
local function corpus_gate(manifest, measured)
    local mismatches = {}
    local checked = 0
    local expected_fixtures = 0
    local roster = {}
    for _, fixture in ipairs(manifest.fixtures or {}) do
        roster[fixture.id] = true
        if not corpus_excluded[fixture.id] then
            expected_fixtures = expected_fixtures + 1
            local reads = measured[fixture.id]
            if reads == nil then
                mismatches[#mismatches + 1] = fixture.id .. " was not measured (missing platform or locator)"
            elseif reads.error then
                mismatches[#mismatches + 1] = fixture.id .. " measurement error: " .. tostring(reads.error)
            else
                for key, expected in pairs(fixture.fingerprint or {}) do
                    checked = checked + 1
                    if not approx_equal(key, reads[key], expected) then
                        mismatches[#mismatches + 1] = fixture.id .. "." .. key .. "=" .. tostring(reads[key]) .. " expected " .. tostring(expected)
                    end
                end
            end
        end
    end
    for id in pairs(measured) do
        if not roster[id] then
            mismatches[#mismatches + 1] = id .. " was measured but is not in the manifest roster"
        elseif corpus_excluded[id] then
            mismatches[#mismatches + 1] = id .. " is corpus-excluded but was measured by measure_corpus"
        end
    end
    if expected_fixtures == 0 then
        mismatches[#mismatches + 1] = "manifest roster carried no measurable fixtures"
    end
    return {
        exact = #mismatches == 0,
        mismatches = mismatches,
        fieldsChecked = checked,
        fixturesMeasured = table_size(measured),
        expectedFixtures = expected_fixtures,
    }
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
    local surface, platform = surface_for_platform(specification.platformName)
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
    local surface = game.surfaces[pilot.sourceSurface]
    local source = find_belts(surface, pilot.sourceBelts, false)
    local target = find_belts(surface, pilot.targetBelts, false)
    local all = detailed_census(source)
    local measured = measure_corpus(manifest)
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
        surfaceSettings = read_lab_surface_settings(),
        transient = transient_state(),
        census = surface_census(),
        corpus = measured,
    }
    -- expected is sourced from the manifest belt fingerprint (single source of truth), passed via
    -- the belt pilot: beltCount/sourceQuantity/sourceLineQuantities/maximumStack/physicalStacks.
    local expected = pilot.expected
    reading.beltFixtureExact = reading.sourceBelts == expected.beltCount and reading.targetBelts == expected.beltCount
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
    reading.corpusGate = corpus_gate(manifest, measured)
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
