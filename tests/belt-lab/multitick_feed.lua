-- Phase 1b: feed the input belt; called repeatedly with real-time gaps so the live server's belt
-- FLOW carries items east and packs them against the wall (compression past insert_at density).
local L = storage.belt_lab
local b = L.belts[1]
for line_idx = 1, 2 do
    local line = b.get_transport_line(line_idx)
    if line and line.valid then
        for _ = 1, 6 do
            if line.can_insert_at_back() then line.insert_at_back({ name = L.item, count = 4 }) end
        end
    end
end
-- Authoritative whole-chain count: dedup by item unique_id (an item seen through two belt windows
-- counts once) — the same identity-based instrument the production gate needs (advisor).
local function chain_count(belts)
    local seen, total = {}, 0
    for _, belt in ipairs(belts) do
        for li = 1, 8 do
            local ok, ln = pcall(belt.get_transport_line, belt, li)
            if not ok or not ln or not ln.valid then break end
            for _, it in ipairs(ln.get_detailed_contents()) do
                if not seen[it.unique_id] then seen[it.unique_id] = true; total = total + it.stack.count end
            end
        end
    end
    return total
end
-- Compression probe on the belt nearest the wall (last tile): report the slot positions on line 1.
local last = L.belts[#L.belts]
local probe = {}
for _, it in ipairs(last.get_transport_line(1).get_detailed_contents()) do probe[#probe + 1] = string.format("%.3f", it.position) end
rcon.print(string.format("chain_total=%d  last_belt_line1_positions=[%s]", chain_count(L.belts), table.concat(probe, ",")))
