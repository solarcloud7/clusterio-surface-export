local FluidOwnership = {}

local function connection_categories(fluidbox_prototype)
    local categories = {}
    for _, connection in pairs((fluidbox_prototype and fluidbox_prototype.pipe_connections) or {}) do
        local value = connection.connection_category
        if type(value) == "string" then
            categories[value] = true
        else
            for _, category in pairs(value or {}) do
                categories[category] = true
            end
        end
    end
    return categories
end

local function box_prototype(entity, index)
    local prototypes = entity and entity.valid and entity.prototype
        and entity.prototype.fluidbox_prototypes or nil
    return prototypes and prototypes[index] or nil
end

function FluidOwnership.is_engine_owned_box(entity, index)
    local prototype = box_prototype(entity, index)
    if not prototype then return false end

    local categories = connection_categories(prototype)
    local has_category = false
    for category in pairs(categories) do
        has_category = true
        if category == "default" then return false end
    end
    return has_category
end

local function warn_if_unexpected(entity, index, warned)
    if not FluidOwnership.is_engine_owned_box(entity, index) then return end
    local categories = connection_categories(box_prototype(entity, index))
    local names, fusion_only = {}, true
    for category in pairs(categories) do
        names[#names + 1] = category
        if category ~= "fusion-plasma" then fusion_only = false end
    end
    table.sort(names)
    local fusion_prototype = string.find(entity.name, "fusion-", 1, true) == 1
    if fusion_only and fusion_prototype then return end

    local key = entity.name .. ":" .. tostring(index) .. ":" .. table.concat(names, ",")
    if warned[key] then return end
    warned[key] = true
    log(string.format(
        "[Fluid Ownership] WARNING: unexpected non-default connection category on %s box %d: %s; " ..
        "engine pin/category classification requires review",
        entity.name, index, table.concat(names, ",")
    ))
end

function FluidOwnership.collect_engine_owned_segments(entities)
    local segments, warned = {}, {}
    for _, entity in ipairs(entities or {}) do
        if entity.valid and entity.fluidbox then
            for i = 1, #entity.fluidbox do
                if FluidOwnership.is_engine_owned_box(entity, i) then
                    warn_if_unexpected(entity, i, warned)
                    local segment_id = entity.fluidbox.get_fluid_segment_id(i)
                    if segment_id then segments[segment_id] = true end
                end
            end
        end
    end
    return segments
end

return FluidOwnership
