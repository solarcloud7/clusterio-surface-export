local SurfaceCounter = require("modules/surface_export/validators/surface-counter")
local Verification = require("modules/surface_export/validators/verification")
local Util = require("modules/surface_export/utils/util")
local PropertyProbes = require("modules/surface_export/export_scanners/property-probes")

local CensusAccumulator = {}

local EXACT_EPSILON = 1e-6

local function new_fluid_state()
    return {
        counted_segments = {},
        seg_temps = {},
    }
end

local function add_into(totals, contribution)
    for key, amount in pairs(contribution or {}) do
        totals[key] = (totals[key] or 0) + amount
    end
end

local function item_key_delta(expected, actual)
    local delta, keys = {}, {}
    for key in pairs(expected) do keys[key] = true end
    for key in pairs(actual) do keys[key] = true end
    for key in pairs(keys) do
        local value = (actual[key] or 0) - (expected[key] or 0)
        if value ~= 0 then delta[key] = value end
    end
    return delta
end

local function aggregate_fluids_by_name(fluid_counts)
    local by_name = {}
    for fluid_key, volume in pairs(fluid_counts or {}) do
        local name = Util.parse_fluid_temp_key(fluid_key)
        by_name[name] = (by_name[name] or 0) + (volume or 0)
    end
    return by_name
end

local function fluid_name_delta(expected_by_name, actual_by_name)
    local delta, names = {}, {}
    for name in pairs(expected_by_name) do names[name] = true end
    for name in pairs(actual_by_name) do names[name] = true end
    for name in pairs(names) do
        local value = (actual_by_name[name] or 0) - (expected_by_name[name] or 0)
        if math.abs(value) > EXACT_EPSILON then delta[name] = value end
    end
    return delta
end

local function build_row(entity, entity_data, phys_items, ser_items, item_delta)
    return {
        unit_number = entity.unit_number,
        entity_id = entity_data.entity_id,
        entity_name = entity.name,
        entity_type = entity.type,
        position = { x = entity.position.x, y = entity.position.y },
        expected = phys_items,
        actual = ser_items,
        delta = item_delta,
    }
end

function CensusAccumulator.new(fluid_registry)
    if not fluid_registry then
        error("CensusAccumulator.new requires the job's FluidRegistry " ..
            "(the serialized-side fluid truth) — see the FLUIDS ON 2.1 header note")
    end
    return {
        physical_items = {},
        serialized_items = {},
        physical_fluids = {},
        serialized_fluids = {},
        mismatches = {},
        property_findings = {},
        entity_count = 0,
        fluid_registry = fluid_registry,
        seen_segment_refs = {},
        fluid_state = new_fluid_state(),
    }
end

function CensusAccumulator.record(acc, entity, entity_data, fluid_state)
    fluid_state = fluid_state or acc.fluid_state
    acc.entity_count = acc.entity_count + 1

    local phys_items = SurfaceCounter.count_entity_items(entity)
    local phys_fluids = SurfaceCounter.count_entity_fluids(entity, fluid_state)

    local one = { entity_data }
    local ser_items = Verification.count_all_items(one)
    local ser_fluids = {}
    local boxes = entity_data.specific_data and entity_data.specific_data.fluidboxes
    if boxes then
        for _, box in ipairs(boxes) do
            local ref = box.segment_ref
            if ref and not acc.seen_segment_refs[ref] then
                acc.seen_segment_refs[ref] = true
                local rec = acc.fluid_registry.segments[ref]
                if rec and rec.fluid and (rec.total or 0) > 0 then
                    local key = Util.make_fluid_temp_key(rec.fluid, rec.temperature or 15)
                    ser_fluids[key] = (ser_fluids[key] or 0) + rec.total
                end
            end
        end
    end

    add_into(acc.physical_items, phys_items)
    add_into(acc.serialized_items, ser_items)
    add_into(acc.physical_fluids, phys_fluids)
    add_into(acc.serialized_fluids, ser_fluids)

    local item_delta = item_key_delta(phys_items, ser_items)
    if next(item_delta) ~= nil then
        acc.mismatches[#acc.mismatches + 1] =
            build_row(entity, entity_data, phys_items, ser_items, item_delta)
    end

    for _, finding in ipairs(PropertyProbes.compare(entity, entity_data) or {}) do
        acc.property_findings[#acc.property_findings + 1] = finding
    end
end

function CensusAccumulator.verdict(acc)
    local item_delta = item_key_delta(acc.physical_items, acc.serialized_items)
    local phys_fluids_by_name = aggregate_fluids_by_name(acc.physical_fluids)
    local ser_fluids_by_name = aggregate_fluids_by_name(acc.serialized_fluids)
    local fluid_delta = fluid_name_delta(phys_fluids_by_name, ser_fluids_by_name)

    local items_exact = next(item_delta) == nil
    local fluids_exact = next(fluid_delta) == nil
    local ok = (#acc.mismatches == 0) and items_exact and fluids_exact

    return {
        ok = ok,
        mismatches = acc.mismatches,
        property_findings = acc.property_findings,
        totals = {
            entity_count = acc.entity_count,
            physical_items = acc.physical_items,
            serialized_items = acc.serialized_items,
            physical_fluids_by_name = phys_fluids_by_name,
            serialized_fluids_by_name = ser_fluids_by_name,
            item_delta = item_delta,
            fluid_delta = fluid_delta,
            items_exact = items_exact,
            fluids_exact = fluids_exact,
        },
    }
end

return CensusAccumulator
