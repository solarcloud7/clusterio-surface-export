local GameUtils = require("modules/surface_export/utils/game-utils")
local Util = require("modules/surface_export/utils/util")

local CargoCounter = {}

-- Required reads throw. Callers must reject unavailable measurements, never treat them as zero.
local function add_contents(totals, contents)
    for _, item in ipairs(contents) do
        assert(type(item.count) == "number" and item.count >= 0 and item.count < math.huge,
            "invalid cargo quantity")
        local key = Util.make_quality_key(item.name, item.quality or Util.QUALITY_NORMAL)
        totals[key] = (totals[key] or 0) + item.count
    end
end

local function add_stack(totals, stack)
    if stack and stack.valid_for_read then
        add_contents(totals, {{name = stack.name, count = stack.count,
            quality = stack.quality and stack.quality.name or Util.QUALITY_NORMAL}})
    end
end

function CargoCounter.count_ground_items(surface)
    local totals = {}
    local total = 0
    if not surface or not surface.valid then
        error("Cargo integrity: ground surface unavailable")
    end
    for _, item_entity in ipairs(surface.find_entities_filtered({type = "item-entity"})) do
        for key, count in pairs(CargoCounter.count_entity_items(item_entity, "ground")) do
            totals[key] = (totals[key] or 0) + count
            total = total + count
        end
    end
    return totals, total
end

function CargoCounter.count_entity_items(entity, subject)
    local totals = {}
    if not entity or not entity.valid then
        error("Cargo integrity: entity unavailable")
    end

    local etype = entity.type

    if subject == nil or subject == "inventories" then
        local success, err = pcall(function()
            local seen = {}
            for i = 1, entity.get_max_inventory_index() do
                local inventory = entity.get_inventory(i)
                if inventory then
                    assert(inventory.valid, "inventory unavailable")
                    if not seen[inventory] then
                        seen[inventory] = true
                        add_contents(totals, inventory.get_contents())
                    end
                end
            end
        end)

        if not success then
            error(string.format("Cargo integrity: inventories of %s unavailable: %s", entity.name, err))
        end
    end

    if (subject == nil or subject == "belts") and GameUtils.BELT_ENTITY_TYPES[etype] then
        local ok, belt_err = pcall(function()
            for i = 1, entity.get_max_transport_line_index() do
                local line = entity.get_transport_line(i)
                assert(line and line.valid, "belt line unavailable")
                add_contents(totals, line.get_contents())
            end
        end)

        if not ok then
            error(string.format("Cargo integrity: belts of %s unavailable: %s", entity.name, belt_err))
        end
    end

    if (subject == nil or subject == "held") and etype == "inserter" then
        local ok, ins_err = pcall(function()
            add_stack(totals, entity.held_stack)
        end)

        if not ok then
            error(string.format("Cargo integrity: held items of %s unavailable: %s", entity.name, ins_err))
        end
    end

    if subject == "ground" and etype == "item-entity" then
        local ok, ground_err = pcall(function()
            add_stack(totals, entity.stack)
        end)

        if not ok then
            error(string.format("Cargo integrity: ground item %s unavailable: %s", entity.name, ground_err))
        end
    end

    return totals
end

function CargoCounter.count_items(surface)
    if not surface or not surface.valid then
        error("Cargo integrity: item surface unavailable")
    end

    local item_totals = {}
    local total = 0

    local entities = surface.find_entities_filtered({})

    for _, entity in ipairs(entities) do
        assert(entity.valid, "Cargo integrity: enumerated entity unavailable")
        if entity.valid then
            local entity_totals = CargoCounter.count_entity_items(entity)
            for key, count in pairs(entity_totals) do
                item_totals[key] = (item_totals[key] or 0) + count
                total = total + count
            end
        end
    end

    local ground_totals, ground_total = CargoCounter.count_ground_items(surface)
    for key, count in pairs(ground_totals) do
        item_totals[key] = (item_totals[key] or 0) + count
    end
    total = total + ground_total

    return item_totals, total
end

function CargoCounter.count_entity_fluids(entity, state)
    local totals = {}
    if not entity or not entity.valid then
        error("Cargo integrity: fluid entity unavailable")
    end

    local counted_segments = state.counted_segments
    local seg_temps = state.seg_temps or {}

    local success, err = pcall(function()
        local count = entity.fluids_count
        assert(type(count) == "number", "fluid count unavailable")
        if count == 0 then
            return
        end
        for i = 1, count do
            if entity.has_fluid_segment(i) then
                local seg_id = entity.get_fluid_segment_id(i)
                assert(seg_id ~= nil, "fluid segment identity unavailable")
                if seg_id and not counted_segments[seg_id] then
                    counted_segments[seg_id] = true
                    local seg_fluid = entity.get_fluid_segment_fluid(i)
                    if seg_fluid and seg_fluid.name and (seg_fluid.amount or 0) > 0 then
                        local temp
                        local st = seg_temps[seg_id]
                        if st and st.fluid == seg_fluid.name then
                            temp = st.temp
                        else
                            temp = seg_fluid.temperature or 15
                        end
                        local key = Util.make_fluid_temp_key(seg_fluid.name, temp)
                        totals[key] = (totals[key] or 0) + seg_fluid.amount
                    end
                end
            else
                local fluid = entity.get_fluid(i)
                if fluid and fluid.name and (fluid.amount or 0) > 0 then
                    local key = Util.make_fluid_temp_key(fluid.name, fluid.temperature or 15)
                    totals[key] = (totals[key] or 0) + fluid.amount
                end
            end
        end
    end)

    if not success then
        error(string.format("Cargo integrity: fluids of %s unavailable: %s", entity.name, err))
    end

    return totals
end

function CargoCounter.count_fluids(surface, segment_temps)
    if not surface or not surface.valid then
        error("Cargo integrity: fluid surface unavailable")
    end

    local fluid_totals = {}
    local total = 0

    local entities = surface.find_entities_filtered({})

    local state = {
        counted_segments = {},
        seg_temps = segment_temps or {},
    }

    for _, entity in ipairs(entities) do
        assert(entity.valid, "Cargo integrity: enumerated entity unavailable")
        if entity.valid then
            local entity_totals = CargoCounter.count_entity_fluids(entity, state)
            for key, amount in pairs(entity_totals) do
                fluid_totals[key] = (fluid_totals[key] or 0) + amount
                total = total + amount
            end
        end
    end

    return fluid_totals, total
end

function CargoCounter.count_all(surface, segment_temps)
    local item_counts, item_total = CargoCounter.count_items(surface)
    local fluid_counts, fluid_total = CargoCounter.count_fluids(surface, segment_temps)
    return {
        item_counts = item_counts,
        item_total = item_total,
        fluid_counts = fluid_counts,
        fluid_total = fluid_total,
    }
end

return CargoCounter
