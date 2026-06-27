-- Re-acquire BY SURFACE NAME + position (stored entity handles can go stale across load) and recount.
local T = storage.stack_load_test
if not T then rcon.print("NO TEST STATE (storage lost?)"); return end
local s = game.surfaces[T.surface]
if not s then rcon.print("SURFACE GONE after load"); return end
local belt = s.find_entity("turbo-transport-belt", { T.bx, T.by })
if not belt then rcon.print("BELT GONE after load"); return end
local total, desc = 0, {}
for li = 1, 2 do
    local ok, ln = pcall(function() return belt.get_transport_line(li) end)
    if ok and ln then
        for _, it in ipairs(ln.get_detailed_contents()) do
            total = total + it.stack.count
            desc[#desc + 1] = it.stack.count .. "@" .. string.format("%.2f", it.position)
        end
    end
end
local ground = 0
for _, e in ipairs(s.find_entities_filtered({ type = "item-entity" })) do
    if e.stack and e.stack.valid_for_read then ground = ground + e.stack.count end
end
rcon.print(string.format("AFTER LOAD: line_total=%d ground=%d slots=[%s]", total, ground, table.concat(desc, ",")))
