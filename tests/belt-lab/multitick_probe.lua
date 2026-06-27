local L = storage.belt_lab
local last = L.belts[#L.belts]   -- belt against the wall
local first = L.belts[1]
local function describe(belt, tag)
    local ln = belt.get_transport_line(1)
    local n = ln.get_item_count()
    local len = ln.line_length
    local pos = {}
    for _, it in ipairs(ln.get_detailed_contents()) do pos[#pos + 1] = string.format("%.3f", it.position) end
    return string.format("%s: count=%d len=%.4f positions=[%s]", tag, n, len, table.concat(pos, ","))
end
rcon.print(describe(last, "WALL-END belt line1"))
rcon.print(describe(first, "INPUT belt line1"))
