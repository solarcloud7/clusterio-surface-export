local Json = require("modules/surface_export/utils/json-compat")
local PayloadEncoder = {}

local function encode(value)
    local scalar = type(value) ~= "table"
    local result, err = Json.encode_json_compat(scalar and {value} or value)
    assert(result, err or "Payload JSON encoding failed")
    if scalar then
        assert(result:sub(1, 1) == "[" and result:sub(-1) == "]", "Unexpected JSON scalar encoding")
        return result:sub(2, -2)
    end
    return result
end

-- Keep the existing JSON object and array format. Only encoding work is split;
-- compressed transport bytes and source diagnostics reuse the final joined string.
function PayloadEncoder.process(job, entity_budget)
    entity_budget = math.max(1, math.floor((entity_budget or 50) / 5))
    local payload = job.export_data
    local state = job.json_cursor
    if not state then
        if #(payload.entities or {}) <= entity_budget and #(payload.tiles or {}) <= entity_budget * 100 then
            return encode(payload)
        end
        local keys = {}
        for key in pairs(payload) do
            assert(type(key) == "string", "Payload object keys must be strings")
            keys[#keys + 1] = key
        end
        table.sort(keys)
        state = {keys = keys, index = 1, parts = {"{"}}
        job.json_cursor = state
    end
    local key = state.keys[state.index]
    if not key then
        state.parts[#state.parts + 1] = "}"
        local result = table.concat(state.parts)
        job.json_cursor = nil
        return result
    end
    local value = payload[key]
    if not state.array_index then
        -- Encode the key using the native encoder too, preserving its escaping.
        local wrapper = encode({key})
        assert(wrapper:sub(1, 1) == "[" and wrapper:sub(-1) == "]", "Unexpected JSON key encoding")
        state.parts[#state.parts + 1] = (state.index > 1 and "," or "") .. wrapper:sub(2, -2) .. ":"
        if (key == "entities" or key == "tiles") and #value > 0 then
            state.parts[#state.parts + 1] = "["
            state.array_index = 1
        else
            state.parts[#state.parts + 1] = encode(value)
            state.index = state.index + 1
            return nil
        end
    end
    local budget = key == "tiles" and entity_budget * 100 or entity_budget
    local last = math.min(#value, state.array_index + budget - 1)
    local batch = {}
    for i = state.array_index, last do batch[#batch + 1] = value[i] end
    local encoded = encode(batch)
    assert(encoded:sub(1, 1) == "[" and encoded:sub(-1) == "]", "Expected dense payload array")
    state.parts[#state.parts + 1] = (state.array_index > 1 and "," or "") .. encoded:sub(2, -2)
    if last == #value then
        state.parts[#state.parts + 1] = "]"
        state.array_index = nil
        state.index = state.index + 1
    else state.array_index = last + 1 end
    return nil
end

return PayloadEncoder
