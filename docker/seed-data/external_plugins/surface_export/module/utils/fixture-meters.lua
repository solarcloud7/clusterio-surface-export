-- fixture-meters.lua — the ONE fingerprint-measurement library for the lab-gallery corpus.
--
-- This file is the single source of truth for how each baked fixture is physically MEASURED. It is
-- extracted verbatim from the meter bodies that used to live in tests/lab-gallery/gallery-runtime.lua
-- so the save-patched module (via require) and the plugin-less isolated bake Factorio (via /c source
-- injection) share ONE implementation — the literal duplication between the two meters cost a bake
-- cycle on 2026-07-18 when only one copy was updated.
--
-- Dual-injection contract (do NOT break either):
--   * Module side:   require("modules/surface_export/utils/fixture-meters")
--   * Headless side: local FixtureMeters = (function() <file text> end)()   -- inlined into a /c wrapper
-- Therefore this file MUST be pure Factorio-API Lua with ZERO `require` statements, a single local
-- `M` table, and a trailing `return M`. It also must NOT contain the level-1 long-string close
-- delimiter (a right bracket, an equals, a right bracket) anywhere — it is shipped over RCON by
-- callers that guard against that delimiter, and the shipping guard rejects the whole file on sight.
--
-- Byte-faithful: the parity gate compares readings through both injection paths, so measurement logic
-- must not "improve" — only two ADDITIVE refactors are present (both preserve current behavior by
-- default): whole-surface scans take an optional `area` (nil = whole surface); `anchor_lookup` takes
-- an optional `dx` offset (default 0).

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
-- literal-coordinate duplication between the meters cost a bake cycle during the pad migration
-- (2026-07-18: one meter updated, the other not — verify-save went red on the stale copy); both
-- meters now read the same manifest field. Fail-loud on any missing entry. `dx` (default 0) offsets
-- the resolved x so a pasted right-half copy can be fingerprinted against the same anchors.
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
    -- Quality-keyed splitter filter (the splitter-quality-filter law, absorbed from the retired
    -- entity-roundtrip suite 2026-07-20): quality must ride the filter through paste AND transfer.
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

local function measure_omnibus_midcraft(surface, anchor)
    local m = anchored(surface, anchor, "assembling-machine-1", "omnibus midcraft")
    local inv = m.get_inventory(defines.inventory.crafter_input)
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

-- Whole-surface scans take an optional `area` (nil = whole surface, preserving current behavior) so a
-- pasted right-half copy on the same surface is not double-counted by the /test-run paste audit.
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
    -- Structural fingerprint ONLY: the chest is a lifecycle `mutable` anchor (baked EMPTY, filled by
    -- setup each run), so its contents are excluded — presence/name is the stable baked state.
    local x, y = anchor("steel-chest")
    local chest = at(surface, "steel-chest", x, y)
    return { scratchPresent = chest ~= nil, scratchName = chest and chest.name or "absent" }
end

-- Generic scratch-anchor presence meter (the protocol-teeth pads): structural fingerprint of the
-- single frozen anchor entity. Adds `held` only when the anchor is an inserter with a seated hand
-- (the force-bonus pad pins it; container pads simply omit the key).
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

-- Combined belt omnibus (steady-state class): structure counts + total belt-borne items (constant
-- by saturation physics) + stacking + over-pack. DEFINITIONS (this meter is the law's instrument):
--   * steadyItems = sum of get_item_count() over every belt-class entity in the pad area
--   * maxStack    = max per-position stack count seen across all transport lines
--   * overpackedLanes = transport lines on a single entity holding MORE than 4 items (over the
--     nominal per-tile lane capacity — the owner's hand-built corner over-pack)
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

-- Acid-fed uranium miner (owner-hand-built, frozen): tank + drill fluid, resources under the pad,
-- loose ground items, drill identity.
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
    local resources = surface.find_entities_filtered({ type = "resource", area = area })
    local resource_total = 0
    for _, r in pairs(resources) do resource_total = resource_total + r.amount end
    return {
        tankAcid = tank and tank.get_fluid_count("sulfuric-acid") or nil,
        drillAcid = drill_acid,
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

-- Re-anchored to the belt-corner PAD on the shared omnibus grid (was a dedicated-platform read at a
-- fixed (16.5,0.5)). The corner belt position comes from the manifest anchor; the belt scan is scoped
-- to a box around that anchor so the neighbouring loop pad on the SAME grid is never conflated (the
-- two belt pads sit in non-overlapping columns). The old whole-surface `entities` field is dropped —
-- meaningless once the corner shares a surface with 15 other pads.
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
    -- Exact-position lookup (NOT the 0.6-box `at`): on the shared grid the corner sits one tile from
    -- its dead-end, whose collision box overlaps a 0.6 box and would be grabbed instead (measured: the
    -- box read the straight dead-end, cornerShape=straight). find_entity keys on the exact belt centre.
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

-- The 5x5 unstacked loop PAD (belt-5x5-125-unstacked). It stays corpus-EXCLUDED from measure_corpus:
-- its lineQuantities array is asserted by the belt special path (deepEqual), not the scalar corpus
-- gate whose approx_equal does reference-equality on arrays. Scoped to a box around the loop anchor so
-- the corner pad on the same grid is never conflated.
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

-- hold-buffer pairs (card 3): live/held mini-platform pairs, located by platform name. Fingerprint
-- fields are the STABLE subset (booleans/names/integers); spoil floats are informational only
-- (spoil_tick is engine-global and drifts every loaded session).
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

-- Fusion loop (owner-hand-built, ACTIVE): the plasma-and-coolant rig proving buffered fluids and
-- plasma ride the 2.1 fluid-segment registry with nothing engine-excluded. The reactors are ACTIVE,
-- so coolant/plasma AMOUNTS drift — only STABLE facts are fingerprinted: entity counts, the
-- self-refilling infinity-pipe plasma (exact 100), the generator's own-box no-segment structural fact
-- (2.1 buffer/window duality removed), and fluid-name presence booleans for plasma + coolant.
-- reactorPlasmaMax is diagnostic only (drifts, never pinned). `area` scopes the scan (nil = whole
-- surface). All segment reads are has_fluid_segment-guarded.
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
                -- 2.1 structural fact: the generator's own plasma box exposes no fluid segment id.
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

-- Thruster pair (manifest-only PENDING; the build spec lives in the manifest note). The
-- kill-measurement topology of the reverted 2026-07-19 fusion/thruster fix: two thrusters sharing ONE
-- buffer-class fuel segment (per-box locals must NOT be summed for a shared buffer). Asserts 2
-- thrusters, one shared thruster-fuel segment id across both fuel boxes, and the segment fuel total
-- (counted ONCE per shared segment). Stays UNREACHED while the fixture is runnerExcluded — ships ready.
-- All segment reads are has_fluid_segment-guarded.
local function measure_thruster_pair(surface, area)
    local thrusters = surface.find_entities_filtered({ name = "thruster", area = area })
    local seg_ids = {}
    local counted, fuel_total = {}, 0
    for _, t in ipairs(thrusters) do
        for i = 1, t.fluids_count do
            if t.has_fluid_segment(i) then
                local sf = t.get_fluid_segment_fluid(i)
                if sf and sf.name == "thruster-fuel" then
                    local sid = t.get_fluid_segment_id(i)
                    if sid then
                        seg_ids[#seg_ids + 1] = sid
                        if not counted[sid] then
                            counted[sid] = true
                            fuel_total = fuel_total + sf.amount
                        end
                    end
                end
            end
        end
    end
    local shared = #seg_ids >= 2
    for _, sid in ipairs(seg_ids) do if sid ~= seg_ids[1] then shared = false end end
    return {
        thrusterCount = #thrusters,
        sharedFuelSegment = shared,
        fuelTotal = fuel_total,
    }
end

-- Measure the full baked corpus keyed by manifest fixture id. Locators are code; expected values
-- come from the manifest fingerprints (single source of truth). Each measurement is pcall-guarded
-- and SURFACES its error (never swallows) so a mid-deletion destination poll cannot abort inspect
-- while a normalize-time locator failure still fails the gate loudly.
local function measure_corpus(manifest)
    local out = {}
    local function safe(id, fn)
        -- failure expected per-fixture: the error is not swallowed but captured into out[id].error and
        -- surfaced loudly by corpus_gate ("measurement error: ..."), so one fixture's locator failure
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
        anchored_safe("omnibus-spoilage-midspoil", function(a) return measure_omnibus_spoilage(omni, a) end)
        safe("omnibus-platform-schedule", function() return measure_omnibus_schedule(omni_platform) end)
        anchored_safe("inserter-held-capacity", function(a) return measure_inserter_held(omni, a) end)
        anchored_safe("no-tick-sync-frozen-pair", function(a) return measure_no_tick_pair(omni, a) end)
        anchored_safe("repin-beacon-speed", function(a) return measure_repin_beacon(omni, a) end)
        anchored_safe("belt-corner-recovery", function(a) return measure_belt_corner(omni, a) end)
    end
    local energy = surface_for_platform("lab-energy-v1")
    if energy then safe("energy-accumulator-drain", function() return measure_energy(energy) end) end
    local workhorse = surface_for_platform("lab-transfer-fixture-v1")
    if workhorse then safe("transfer-workhorse", function() return { entities = #workhorse.find_entities_filtered({}) } end) end
    for n = 1, 3 do
        local consumable = surface_for_platform("lab-consumable-" .. n)
        if consumable then safe("consumable-hub-" .. n, function() return { entities = #consumable.find_entities_filtered({}) } end) end
    end
    -- Platform-conditional like the other off-omnibus fixtures: the DESTINATION save has no
    -- platforms, and an unconditional measure records an error row that blocks the dest settle
    -- gate ("still measures corpus fixtures" — v15 bake). The SOURCE corpus gate still fails
    -- loud on absence via the fixturesMeasured/expectedFixtures count.
    if surface_for_platform("lab-hold-spoil-live-v1") then
        safe("hold-buffer-spoil", function() return measure_hold_spoil_pair() end)
    end
    if surface_for_platform("lab-hold-damage-live-v1") then
        safe("hold-buffer-damage", function() return measure_hold_damage_pair() end)
    end
    if surface_for_platform("lab-hold-pod-live-v1") then
        safe("hold-buffer-pod", function() return measure_hold_pod_pair() end)
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

M.table_size = table_size
M.detailed_census = detailed_census
M.surface_for_platform = surface_for_platform
M.at = at
M.anchor_lookup = anchor_lookup
M.anchored = anchored
M.measure_omnibus_adversarial = measure_omnibus_adversarial
M.measure_omnibus_latch = measure_omnibus_latch
M.measure_omnibus_midcraft = measure_omnibus_midcraft
M.measure_omnibus_burner = measure_omnibus_burner
M.measure_omnibus_equipment = measure_omnibus_equipment
M.measure_omnibus_circuit = measure_omnibus_circuit
M.measure_omnibus_bonus = measure_omnibus_bonus
M.measure_omnibus_fluids = measure_omnibus_fluids
M.measure_omnibus_ghosts = measure_omnibus_ghosts
M.measure_omnibus_ground = measure_omnibus_ground
M.measure_omnibus_spoilage = measure_omnibus_spoilage
M.measure_scratch_anchor = measure_scratch_anchor
M.measure_belt_combined = measure_belt_combined
M.measure_mining_drill_acid = measure_mining_drill_acid
M.measure_omnibus_schedule = measure_omnibus_schedule
M.measure_energy = measure_energy
M.measure_belt_corner = measure_belt_corner
M.measure_belt_loop = measure_belt_loop
M.measure_inserter_held = measure_inserter_held
M.measure_no_tick_pair = measure_no_tick_pair
M.measure_repin_beacon = measure_repin_beacon
M.measure_hold_spoil_pair = measure_hold_spoil_pair
M.measure_hold_damage_pair = measure_hold_damage_pair
M.measure_hold_pod_pair = measure_hold_pod_pair
M.measure_fusion_loop = measure_fusion_loop
M.measure_thruster_pair = measure_thruster_pair
M.measure_corpus = measure_corpus
M.approx_equal = approx_equal
M.tolerant_double_fields = tolerant_double_fields
M.corpus_excluded = corpus_excluded
M.corpus_gate = corpus_gate

return M
