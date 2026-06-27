local L = storage.belt_lab
local s = game.surfaces[L.surface]
-- per-belt line counts (correct bound-method access)
local parts = {}
for i, belt in ipairs(L.belts) do
    local c = 0
    for li = 1, 8 do
        local ok, ln = pcall(function() return belt.get_transport_line(li) end)
        if not ok or not ln or not ln.valid then break end
        c = c + ln.get_item_count()
    end
    parts[#parts + 1] = tostring(c)
end
-- ground items on the surface (items that fell off the belt)
local ground = 0
for _, e in ipairs(s.find_entities_filtered({ type = "item-entity" })) do
    if e.stack and e.stack.valid_for_read then ground = ground + e.stack.count end
end
rcon.print(string.format("per_belt=[%s]  ground_items=%d", table.concat(parts, ","), ground))
