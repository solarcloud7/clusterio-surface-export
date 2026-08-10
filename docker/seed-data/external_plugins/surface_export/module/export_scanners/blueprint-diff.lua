local BlueprintDiff = {}

BlueprintDiff.STRUCTURAL = {
    entity_number = true,
    name = true,
    position = true,
    direction = true,
    mirror = true,
    type = true,
}

BlueprintDiff.ALIASES = {
    text = "display_panel_text",
    always_show = "display_panel_always_show",
    show_in_chart = "display_panel_show_in_chart",
    wires = "circuit_connections",
    filters = "entity_filters",
    filter = "entity_filters",
    filter_mode = "entity_filters",
    grid = "equipment_grid",
    infinity_settings = "infinity_pipe_filter",
    request_filters = "logistic_sections",
    items = "inventories",
}

BlueprintDiff.PLATFORM_LEVEL = {
    schedule = true,
}

BlueprintDiff.DEFAULT_VALUE = {
    recipe_quality = "normal",
    quality = "normal",
}

local function describe_value(value)
    local kind = type(value)
    if kind ~= "table" then
        return tostring(value)
    end
    local count = 0
    for _ in pairs(value) do count = count + 1 end
    return string.format("<table:%d>", count)
end

local function payload_has(entity_data, key)
    if entity_data[key] ~= nil then
        return true
    end
    local specific = entity_data.specific_data
    return specific ~= nil and specific[key] ~= nil
end

function BlueprintDiff.covered(entity_data, field)
    if payload_has(entity_data, field) then
        return true
    end
    local alias = BlueprintDiff.ALIASES[field]
    return alias ~= nil and payload_has(entity_data, alias)
end

BlueprintDiff.AREA_PADDING = 4

function BlueprintDiff.bounding_area(entities_by_id)
    local min_x, min_y, max_x, max_y
    for _, entity_data in pairs(entities_by_id) do
        local position = entity_data.position
        if position and position.x and position.y then
            min_x = (min_x == nil or position.x < min_x) and position.x or min_x
            min_y = (min_y == nil or position.y < min_y) and position.y or min_y
            max_x = (max_x == nil or position.x > max_x) and position.x or max_x
            max_y = (max_y == nil or position.y > max_y) and position.y or max_y
        end
    end
    if min_x == nil then
        return nil
    end
    local pad = BlueprintDiff.AREA_PADDING
    return { { min_x - pad, min_y - pad }, { max_x + pad, max_y + pad } }
end

function BlueprintDiff.scan(surface, force, entities_by_id)
    local area = BlueprintDiff.bounding_area(entities_by_id)
    if not area then
        return nil, "no positioned entities to bound the blueprint area"
    end

    local inventory = game.create_inventory(1)
    local stack = inventory[1]
    stack.set_stack({ name = "blueprint" })

    local ok, mapping = pcall(function()
        return stack.create_blueprint({
            surface = surface,
            force = force,
            area = area,
            include_entities = true,
            include_modules = true,
            include_station_names = true,
            include_trains = true,
            include_fuel = true,
        })
    end)
    if not ok then
        log(string.format("[BlueprintDiff] create_blueprint failed on '%s': %s", surface.name, tostring(mapping)))
        inventory.destroy()
        return nil, tostring(mapping)
    end

    local blueprint_entities = stack.get_blueprint_entities() or {}
    local findings = {}
    local unpaired = 0

    for index, blueprint_entity in ipairs(blueprint_entities) do
        local world = mapping[index]
        local entity_data = (world and world.valid and world.unit_number) and entities_by_id[world.unit_number] or nil
        if not entity_data then
            unpaired = unpaired + 1
        else
            for field, value in pairs(blueprint_entity) do
                if value ~= nil
                    and not BlueprintDiff.STRUCTURAL[field]
                    and not BlueprintDiff.PLATFORM_LEVEL[field]
                    and BlueprintDiff.DEFAULT_VALUE[field] ~= value
                    and not BlueprintDiff.covered(entity_data, field)
                then
                    findings[#findings + 1] = {
                        property = field,
                        kind = "omitted",
                        entity_name = blueprint_entity.name,
                        entity_type = world.type,
                        unit_number = world.unit_number,
                        position = { x = world.position.x, y = world.position.y },
                        source = "engine_blueprint",
                        live = describe_value(value),
                    }
                end
            end
        end
    end

    inventory.destroy()
    return {
        findings = findings,
        blueprint_entity_count = #blueprint_entities,
        unpaired_entity_count = unpaired,
    }
end

return BlueprintDiff
