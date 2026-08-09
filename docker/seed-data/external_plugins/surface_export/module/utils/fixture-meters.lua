local M = {}

local function table_size(value)
    local count = 0
    for _ in pairs(value or {}) do count = count + 1 end
    return count
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

local function surface_for_platform(name)
    for _, platform in pairs(game.forces.player.platforms) do
        if platform.valid and platform.name == name then return platform.surface, platform end
    end
    return nil, nil
end

local function at(surface, name, x, y)
    return surface.find_entities_filtered({ name = name, area = { { x - 0.6, y - 0.6 }, { x + 0.6, y + 0.6 } } })[1]
end

local function anchor_lookup(manifest, fixture_id, dx)
    dx = dx or 0
    for _, fixture in ipairs(manifest and manifest.fixtures or {}) do
        if fixture.id == fixture_id then
            local anchors = assert(fixture.anchors, fixture_id .. " manifest entry has no anchors")
            return function(entity_name)
                for _, a in ipairs(anchors) do
                    if a.entity == entity_name then return a.x + dx, a.y end
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
    local sp = anchored(surface, anchor, "splitter", "omnibus adversarial")
    local sf = sp.splitter_filter
    r.splitterFilter = sf and sf.name or "absent"
    r.splitterFilterQuality = sf and sf.quality and (sf.quality.name or sf.quality) or "absent"
    return r
end

local function measure_omnibus_latch(surface, anchor)
    local d = anchored(surface, anchor, "decider-combinator", "omnibus latch")
    local net = d.get_circuit_network(defines.wire_connector_id.combinator_output_red)
    return { signalS = net and net.get_signal({ type = "virtual", name = "signal-S" }) or nil }
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
    if lb then r.lampUseColors = lb.use_colors end
    return r
end

local function measure_omnibus_fluids(surface, anchor)
    local r = {}
    local tank = anchored(surface, anchor, "storage-tank", "omnibus fluids")
    local tf = tank.get_fluid(1)
    if tf then r.steam = tf.amount r.steamTemp = tf.temperature end
    local chem = anchored(surface, anchor, "chemical-plant", "omnibus fluids")
    for i = 1, chem.fluids_count do
        local f = chem.get_fluid(i)
        if f then if f.name == "water" then r.chemWater = f.amount elseif f.name == "petroleum-gas" then r.chemGas = f.amount end end
    end
    local foundry = anchored(surface, anchor, "foundry", "omnibus fluids")
    for i = 1, foundry.fluids_count do
        local f = foundry.get_fluid(i)
        if f and f.name == "molten-iron" then r.foundryMolten = f.amount r.foundryTemp = f.temperature end
    end
    return r
end

local function measure_omnibus_ghosts(surface, area)
    local entity_ghosts = surface.find_entities_filtered({ type = "entity-ghost", area = area })
    return {
        entityGhosts = #entity_ghosts,
        tileGhosts = #surface.find_entities_filtered({ type = "tile-ghost", area = area }),
        proxies = #surface.find_entities_filtered({ type = "item-request-proxy", area = area }),
        ghostInner = entity_ghosts[1] and entity_ghosts[1].ghost_name or nil,
    }
end

local function measure_omnibus_ground(surface, area)
    local total = 0
    for _, e in pairs(surface.find_entities_filtered({ type = "item-entity", area = area })) do
        local stack = e.stack
        if stack and stack.valid_for_read and stack.name == "iron-plate" then total = total + stack.count end
    end
    return { ironPlate = total }
end

local function measure_omnibus_spoilage(surface, anchor)
    local x, y = anchor("steel-chest")
    local chest = at(surface, "steel-chest", x, y)
    return { scratchPresent = chest ~= nil, scratchName = chest and chest.name or "absent" }
end

local function measure_scratch_anchor(surface, anchor, ename)
    local x, y = anchor(ename)
    local e = at(surface, ename, x, y)
    local out = { scratchPresent = e ~= nil, scratchName = e and e.name or "absent" }
    if e then
        -- intentional probe: held_stack only exists on inserters; absence is a valid non-reading
        local hs_ok, hs = pcall(function() return e.held_stack end)
        if hs_ok and hs and hs.valid_for_read then out.held = hs.count end
    end
    return out
end

local function measure_belt_combined(surface, area)
    local belt_types = { "transport-belt", "underground-belt", "splitter", "loader", "loader-1x1" }
    local counts = { ["transport-belt"] = 0, ["underground-belt"] = 0, ["splitter"] = 0, loader = 0 }
    local steady, max_stack, overpacked = 0, 0, 0
    local filters = {}
    for _, e in pairs(surface.find_entities_filtered({ type = belt_types, area = area })) do
        if e.type == "loader" or e.type == "loader-1x1" then
            counts.loader = counts.loader + 1
            -- intentional probe: get_filter errors past the loader's filter_slot_count; nil = unfiltered
            local f_ok, f = pcall(function() return e.get_filter(1) end)
            if f_ok and f and f.name then filters[(f.name.name or f.name)] = true end
        else
            counts[e.type] = counts[e.type] + 1
        end
        steady = steady + e.get_item_count()
        for li = 1, e.get_max_transport_line_index() do
            local line = e.get_transport_line(li)
            local line_total = 0
            for ci = 1, #line do
                local stack = line[ci]
                if stack.valid_for_read then
                    line_total = line_total + stack.count
                    if stack.count > max_stack then max_stack = stack.count end
                end
            end
            if line_total > 4 then overpacked = overpacked + 1 end
        end
    end
    return {
        beltCount = counts["transport-belt"], splitterCount = counts["splitter"],
        undergroundCount = counts["underground-belt"], loaderCount = counts.loader,
        steadyItems = steady, maxStack = max_stack,
        overpackedLanes = overpacked, hasOverpackedCornerLanes = overpacked > 0,
        loaderFilterIron = filters["iron-plate"] and "iron-plate" or "absent",
        loaderFilterCopper = filters["copper-plate"] and "copper-plate" or "absent",
    }
end

local function measure_mining_drill_acid(surface, area, anchor)
    local dx, dy = anchor("big-mining-drill")
    local drill = at(surface, "big-mining-drill", dx, dy)
    local tx, ty = anchor("storage-tank")
    local tank = at(surface, "storage-tank", tx, ty)
    local drill_acid = 0
    if drill then
        for i = 1, drill.fluids_count do
            local f = drill.get_fluid(i)
            if f then drill_acid = drill_acid + f.amount end
        end
    end
    local seen, acid_total = {}, 0
    local holders = {}
    if tank then holders[#holders + 1] = tank end
    if drill then holders[#holders + 1] = drill end
    for _, e in ipairs(holders) do
        for i = 1, e.fluids_count do
            if e.has_fluid_segment(i) then
                local id = e.get_fluid_segment_id(i)
                if id and not seen[id] then
                    seen[id] = true
                    local f = e.get_fluid_segment_fluid(i)
                    if f and f.name == "sulfuric-acid" then acid_total = acid_total + f.amount end
                end
            end
        end
    end
    local resources = surface.find_entities_filtered({ type = "resource", area = area })
    local resource_total = 0
    for _, r in pairs(resources) do resource_total = resource_total + r.amount end
    return {
        acidSegmentTotal = acid_total, drillHasAcid = drill_acid > 0,
        resourceCount = #resources, resourceTotal = resource_total,
        groundItems = #surface.find_entities_filtered({ type = "item-entity", area = area }),
        drillName = drill and drill.name or "absent",
    }
end

local function measure_omnibus_schedule(platform)
    local schedule = platform.get_schedule()
    local records = schedule.get_records()
    local interrupts = schedule.get_interrupts()
    return { records = #records, interrupts = #interrupts, interruptName = interrupts[1] and interrupts[1].name or nil }
end

local function count_stable_entities(surface)
    local total = #surface.find_entities_filtered({})
    local transient = #surface.find_entities_filtered({
        type = { "explosion", "item-entity", "projectile", "beam", "smoke-with-trigger", "corpse" },
    })
    return total - transient
end

local function measure_fluid_segments(surface, area)
    local counts = { ["pipe-to-ground"] = 0, pipe = 0, pump = 0 }
    local seen, segment_count = {}, 0
    local totals = {}
    for _, e in pairs(surface.find_entities_filtered({ type = { "pipe-to-ground", "pipe", "pump" }, area = area })) do
        counts[e.type] = counts[e.type] + 1
        for i = 1, e.fluids_count do
            if e.has_fluid_segment(i) then
                local id = e.get_fluid_segment_id(i)
                if not seen[id] then
                    seen[id] = true
                    segment_count = segment_count + 1
                    local f = e.get_fluid_segment_fluid(i)
                    if f then totals[f.name] = (totals[f.name] or 0) + f.amount end
                end
            end
        end
    end
    return {
        pipeToGroundCount = counts["pipe-to-ground"], pipeCount = counts.pipe, pumpCount = counts.pump,
        segmentCount = segment_count,
        lightOilTotal = totals["light-oil"] or 0,
        petroleumGasTotal = totals["petroleum-gas"] or 0,
    }
end

local function measure_active_state(surface)
    local out = {}
    local function count_pair(key, filter)
        local total, inactive = 0, 0
        for _, e in pairs(surface.find_entities_filtered(filter)) do
            if e.valid then
                total = total + 1
                -- intentional probe: a type without .active is not a finding, it is not in scope here
                local ok, active = pcall(function() return e.active end)
                if ok and active == false then inactive = inactive + 1 end
            end
        end
        out[key] = total
        out[key .. "Inactive"] = inactive
    end
    count_pair("spiderVehicles", { type = "spider-vehicle" })
    count_pair("infinityPipes", { name = "infinity-pipe" })
    count_pair("beacons", { type = "beacon" })
    return out
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

local function measure_belt_corner(surface, anchor)
    local cx, cy = anchor("turbo-transport-belt")
    local area = { { cx - 8, cy - 4 }, { cx + 4, cy + 4 } }
    local belts = surface.find_entities_filtered({ type = "transport-belt", area = area })
    local total = 0
    for _, b in ipairs(belts) do
        for line_index = 1, b.get_max_transport_line_index() do
            for _, row in ipairs(b.get_transport_line(line_index).get_detailed_contents()) do total = total + row.stack.count end
        end
    end
    local corner = surface.find_entity("turbo-transport-belt", { cx, cy })
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
    }
end

local function measure_belt_loop(surface, anchor)
    local ax, ay = anchor("turbo-transport-belt")
    local area = { { ax - 1, ay - 1 }, { ax + 6, ay + 6 } }
    local belts = surface.find_entities_filtered({ type = "transport-belt", area = area })
    local all = detailed_census(belts)
    local line1 = detailed_census(belts, 1)
    local line2 = detailed_census(belts, 2)
    local item_name = nil
    for _, b in ipairs(belts) do
        for line_index = 1, b.get_max_transport_line_index() do
            local row = b.get_transport_line(line_index).get_detailed_contents()[1]
            if row then item_name = row.stack.name break end
        end
        if item_name then break end
    end
    return {
        beltName = belts[1] and belts[1].name or nil,
        beltCount = #belts,
        itemName = item_name,
        quantity = all.quantity,
        physicalStacks = all.physicalStacks,
        maximumStack = all.maximumStack,
        lineQuantities = { line1.quantity, line2.quantity },
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

local function measure_hold_spoil_pair()
    local live = surface_for_platform("lab-hold-spoil-live-v1")
    local held = surface_for_platform("lab-hold-spoil-held-v1")
    assert(live and held, "hold-buffer-spoil platforms missing")
    local function read(surface, label)
        local chest = assert(surface.find_entities_filtered({ name = "steel-chest" })[1], label .. " chest missing")
        local stack = chest.get_inventory(defines.inventory.chest)[1]
        assert(stack and stack.valid_for_read, label .. " stack missing")
        -- intentional probe; spoil_percent errors on non-spoilable stacks, a nil reading is valid
        local ok, spoil = pcall(function() return stack.spoil_percent end)
        return { item = stack.name, count = stack.count, spoil = ok and spoil or nil }
    end
    local lr, hr = read(live, "spoil live"), read(held, "spoil held")
    local function seeded(row) return row.spoil ~= nil and row.spoil > 0.5 and row.spoil < 1 end
    return {
        liveItem = lr.item, heldItem = hr.item, liveCount = lr.count, heldCount = hr.count,
        liveSpoilSeeded = seeded(lr), heldSpoilSeeded = seeded(hr),
        bothPaused = live.platform.paused == true and held.platform.paused == true,
    }
end

local function measure_hold_damage_pair()
    local live = surface_for_platform("lab-hold-damage-live-v1")
    local held = surface_for_platform("lab-hold-damage-held-v1")
    assert(live and held, "hold-buffer-damage platforms missing")
    local function read(surface, label)
        local chest = assert(surface.find_entities_filtered({ name = "steel-chest" })[1], label .. " chest missing")
        local asteroid = surface.find_entities_filtered({ force = "neutral" })[1]
        return { chest = true, destructible = chest.destructible,
            healthFull = chest.health == chest.max_health,
            asteroid = asteroid and asteroid.name or nil }
    end
    local lr, hr = read(live, "damage live"), read(held, "damage held")
    return {
        liveChest = lr.chest, heldChest = hr.chest,
        liveChestDestructible = lr.destructible, heldChestDestructible = hr.destructible,
        liveChestHealthFull = lr.healthFull, heldChestHealthFull = hr.healthFull,
        liveAsteroid = lr.asteroid, heldAsteroid = hr.asteroid,
        bothPaused = live.platform.paused == true and held.platform.paused == true,
    }
end

local function measure_hold_pod_pair()
    local live = surface_for_platform("lab-hold-pod-live-v1")
    local held = surface_for_platform("lab-hold-pod-held-v1")
    assert(live and held, "hold-buffer-pod platforms missing")
    local function read(surface)
        local hub = surface.find_entities_filtered({ name = "space-platform-hub" })[1]
        local iron = 0
        if hub then
            local inv = hub.get_inventory(defines.inventory.hub_main)
            iron = inv and inv.get_item_count("iron-plate") or 0
        end
        return { pods = surface.count_entities_filtered({ name = "cargo-pod" }), ironSeeded = iron > 0 }
    end
    local lr, hr = read(live), read(held)
    return {
        livePodCount = lr.pods, heldPodCount = hr.pods,
        liveHubIronSeeded = lr.ironSeeded, heldHubIronSeeded = hr.ironSeeded,
        bothPaused = live.platform.paused == true and held.platform.paused == true,
    }
end

local function measure_fusion_loop(surface, area)
    local function count(name) return #surface.find_entities_filtered({ name = name, area = area }) end
    local plasma_present, coolant_present, reactor_plasma_max, infinity_plasma = false, false, 0, 0
    local generator_plasma_seg_nil = true
    local function scan(entities, is_reactor, is_generator, is_infinity)
        for _, e in pairs(entities) do
            for i = 1, e.fluids_count do
                local f = e.get_fluid(i)
                if f and f.amount > 0 then
                    if f.name == "fusion-plasma" then
                        plasma_present = true
                        if is_reactor and f.amount > reactor_plasma_max then reactor_plasma_max = f.amount end
                        if is_infinity then infinity_plasma = infinity_plasma + f.amount end
                    elseif f.name == "fluoroketone-cold" or f.name == "fluoroketone-hot" then
                        coolant_present = true
                    end
                end
                if is_generator and f and f.name == "fusion-plasma" then
                    generator_plasma_seg_nil = (not e.has_fluid_segment(i)) or e.get_fluid_segment_id(i) == nil
                end
            end
        end
    end
    scan(surface.find_entities_filtered({ name = "fusion-reactor", area = area }), true, false, false)
    scan(surface.find_entities_filtered({ name = "fusion-generator", area = area }), false, true, false)
    scan(surface.find_entities_filtered({ name = "cryogenic-plant", area = area }), false, false, false)
    scan(surface.find_entities_filtered({ name = "pipe", area = area }), false, false, false)
    scan(surface.find_entities_filtered({ name = "infinity-pipe", area = area }), false, false, true)
    return {
        reactorCount = count("fusion-reactor"),
        generatorCount = count("fusion-generator"),
        cryoCount = count("cryogenic-plant"),
        infinityPipeCount = count("infinity-pipe"),
        pipeCount = count("pipe"),
        infinityPipePlasma = infinity_plasma,
        generatorPlasmaSegNil = generator_plasma_seg_nil,
        plasmaPresent = plasma_present,
        coolantPresent = coolant_present,
        reactorPlasmaMax = reactor_plasma_max,
    }
end

local function measure_thruster_pair(surface, area)
    local thrusters = surface.find_entities_filtered({ name = "thruster", area = area })
    local function shared_total(fluid_name)
        local seg_ids = {}
        local counted, total = {}, 0
        for _, t in ipairs(thrusters) do
            for i = 1, t.fluids_count do
                if t.has_fluid_segment(i) then
                    local sf = t.get_fluid_segment_fluid(i)
                    if sf and sf.name == fluid_name then
                        local sid = t.get_fluid_segment_id(i)
                        if sid then
                            seg_ids[#seg_ids + 1] = sid
                            if not counted[sid] then
                                counted[sid] = true
                                total = total + sf.amount
                            end
                        end
                    end
                end
            end
        end
        local shared = #seg_ids >= 2
        for _, sid in ipairs(seg_ids) do if sid ~= seg_ids[1] then shared = false end end
        return shared, total
    end
    local fuel_shared, fuel_total = shared_total("thruster-fuel")
    local oxidizer_shared, oxidizer_total = shared_total("thruster-oxidizer")
    return {
        thrusterCount = #thrusters,
        sharedFuelSegment = fuel_shared,
        fuelTotal = fuel_total,
        sharedOxidizerSegment = oxidizer_shared,
        oxidizerTotal = oxidizer_total,
    }
end

local tolerant_double_fields = { progress = true, bonusProgress = true }

local function approx_equal(key, a, b)
    if type(b) == "table" and #b == 2 and type(b[1]) == "number" and type(b[2]) == "number" then
        return type(a) == "number" and a >= b[1] and a <= b[2]
    end
    if tolerant_double_fields[key] and type(a) == "number" and type(b) == "number" then
        return math.abs(a - b) <= 1e-9
    end
    return a == b
end



M.table_size = table_size
M.detailed_census = detailed_census
M.surface_for_platform = surface_for_platform
M.at = at
M.anchor_lookup = anchor_lookup
M.anchored = anchored
M.measure_omnibus_adversarial = measure_omnibus_adversarial
M.measure_omnibus_latch = measure_omnibus_latch


M.measure_omnibus_equipment = measure_omnibus_equipment
M.measure_omnibus_circuit = measure_omnibus_circuit

M.measure_omnibus_fluids = measure_omnibus_fluids
M.measure_omnibus_ghosts = measure_omnibus_ghosts
M.measure_omnibus_ground = measure_omnibus_ground
M.measure_omnibus_spoilage = measure_omnibus_spoilage
M.measure_scratch_anchor = measure_scratch_anchor
M.measure_belt_combined = measure_belt_combined
M.measure_mining_drill_acid = measure_mining_drill_acid
M.measure_omnibus_schedule = measure_omnibus_schedule
M.measure_energy = measure_energy
M.measure_active_state = measure_active_state
M.measure_belt_corner = measure_belt_corner
M.measure_belt_loop = measure_belt_loop

M.measure_no_tick_pair = measure_no_tick_pair
M.measure_repin_beacon = measure_repin_beacon
M.measure_hold_spoil_pair = measure_hold_spoil_pair
M.measure_hold_damage_pair = measure_hold_damage_pair
M.measure_hold_pod_pair = measure_hold_pod_pair
M.measure_fusion_loop = measure_fusion_loop
M.measure_thruster_pair = measure_thruster_pair

M.approx_equal = approx_equal
M.tolerant_double_fields = tolerant_double_fields
M.count_stable_entities = count_stable_entities
M.measure_fluid_segments = measure_fluid_segments



return M
