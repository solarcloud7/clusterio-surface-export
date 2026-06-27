-- Re-read after real-time belt flow: did the over-sized stack survive, clamp, or shed items to ground?
local P = storage.stack_persist
local s = game.surfaces[P.surface]
local function count_line(belt, li)
    local ok, ln = pcall(function() return belt.get_transport_line(li) end)
    if not ok or not ln then return 0, "" end
    local c, pos = 0, {}
    for _, it in ipairs(ln.get_detailed_contents()) do c = c + it.stack.count; pos[#pos + 1] = it.stack.count .. "@" .. string.format("%.2f", it.position) end
    return c, table.concat(pos, ",")
end
local total = 0
local parts = {}
for i, belt in ipairs(P.belts) do
    local c1, d1 = count_line(belt, 1)
    local c2 = select(1, count_line(belt, 2))
    total = total + c1 + c2
    parts[#parts + 1] = string.format("belt%d L1[%s]", i, d1)
end
local ground = 0
for _, e in ipairs(s.find_entities_filtered({ type = "item-entity" })) do
    if e.stack and e.stack.valid_for_read then ground = ground + e.stack.count end
end
rcon.print(string.format("after_flow: chain_total=%d ground=%d  %s", total, ground, table.concat(parts, " | ")))
