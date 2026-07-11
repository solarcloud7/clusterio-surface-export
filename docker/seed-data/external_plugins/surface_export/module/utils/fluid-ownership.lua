local FluidOwnership = {}

-- Factorio exposes whether a box is an output, but not whether the engine owns its
-- contents after script writes. P1 establishes this behavior for fusion reactors;
-- add prototypes here only with equivalent empirical evidence.
local ENGINE_MANAGED_OUTPUT_ENTITIES = {
    ["fusion-reactor"] = true,
}

function FluidOwnership.is_engine_owned_box(entity, index)
    if not entity or not entity.valid or not entity.prototype then
        return false
    end
    local prototypes = entity.prototype.fluidbox_prototypes
    local prototype = prototypes and prototypes[index]
    return ENGINE_MANAGED_OUTPUT_ENTITIES[entity.name] == true
        and prototype ~= nil
        and prototype.production_type == "output"
end

function FluidOwnership.collect_engine_owned_segments(entities)
    local segments = {}
    for _, entity in ipairs(entities or {}) do
        if entity.valid and entity.fluidbox then
            for i = 1, #entity.fluidbox do
                if FluidOwnership.is_engine_owned_box(entity, i) then
                    local segment_id = entity.fluidbox.get_fluid_segment_id(i)
                    if segment_id then
                        segments[segment_id] = true
                    end
                end
            end
        end
    end
    return segments
end

return FluidOwnership
