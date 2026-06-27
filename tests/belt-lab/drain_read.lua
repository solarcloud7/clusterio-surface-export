local T = storage.drain_test
local s = game.surfaces[T.surface]
local belt = s.find_entity("turbo-transport-belt", { T.bx, T.by })
local chest = s.find_entity("steel-chest", { T.cx, T.cy })
local ins = s.find_entity("bulk-inserter", { T.ix, T.iy })
local belt_n = 0
if belt then for li = 1, 2 do local ok, ln = pcall(function() return belt.get_transport_line(li) end); if ok and ln then belt_n = belt_n + ln.get_item_count() end end end
local chest_n = 0
if chest then local inv = chest.get_inventory(defines.inventory.chest); if inv then chest_n = inv.get_item_count("iron-plate") end end
local held = 0
if ins and ins.held_stack and ins.held_stack.valid_for_read then held = ins.held_stack.count end
local ground = 0
for _, e in ipairs(s.find_entities_filtered({ type = "item-entity" })) do if e.stack and e.stack.valid_for_read then ground = ground + e.stack.count end end
rcon.print(string.format("DRAIN: belt=%d held=%d chest=%d ground=%d  TOTAL=%d (want 20)", belt_n, held, chest_n, ground, belt_n + held + chest_n + ground))
