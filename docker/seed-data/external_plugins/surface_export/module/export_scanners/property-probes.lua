local PropertyProbes = {}

local function filter_equal(a, b)
    return a.name == b.name
        and (a.percentage or 0) == (b.percentage or 0)
        and (a.temperature or false) == (b.temperature or false)
        and (a.mode or "at-least") == (b.mode or "at-least")
end

local function filter_describe(f)
    return string.format("%s pct=%s mode=%s temp=%s",
        tostring(f.name), tostring(f.percentage), tostring(f.mode), tostring(f.temperature))
end

PropertyProbes.probes = {
    {
        name = "infinity_pipe_filter",
        applies_to = { ["infinity-pipe"] = true },
        live = function(entity)
            local ok, filter = pcall(function() return entity.get_infinity_pipe_filter() end)
            if not ok then
                log(string.format("[PropertyProbes] get_infinity_pipe_filter threw on %s @%s,%s: %s",
                    entity.name, entity.position.x, entity.position.y, tostring(filter)))
                return nil
            end
            return filter
        end,
        serialized = function(entity_data) return entity_data.infinity_pipe_filter end,
        equal = filter_equal,
        describe = filter_describe,
    },
}

function PropertyProbes.compare(entity, entity_data)
    local findings
    for _, probe in ipairs(PropertyProbes.probes) do
        if probe.applies_to[entity.type] then
            local live = probe.live(entity)
            local serialized = probe.serialized(entity_data)
            local kind
            if live ~= nil and serialized == nil then
                kind = "omitted"
            elseif live == nil and serialized ~= nil then
                kind = "fabricated"
            elseif live ~= nil and serialized ~= nil and not probe.equal(live, serialized) then
                kind = "altered"
            end
            if kind then
                findings = findings or {}
                findings[#findings + 1] = {
                    property = probe.name,
                    kind = kind,
                    entity_name = entity.name,
                    entity_type = entity.type,
                    unit_number = entity.unit_number,
                    position = { x = entity.position.x, y = entity.position.y },
                    live = live and probe.describe(live) or nil,
                    serialized = serialized and probe.describe(serialized) or nil,
                }
            end
        end
    end
    return findings
end

return PropertyProbes
