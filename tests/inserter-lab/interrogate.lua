-- Interrogate the locally-reproduced failing import (ci_repro). Find railgun-ammo-holding inserters, report
-- the held distribution, then deep-inspect + API-sandbox ONE failing inserter.
local plat = nil
for _, p in pairs(game.forces.player.platforms) do if p.name == "ci_repro" then plat = p end end
if not plat then rcon.print("no ci_repro"); return end
local s = plat.surface
local function held(e) return e.valid and e.held_stack.valid_for_read and e.held_stack.count or 0 end
local total, n, hist, offender = 0, 0, {}, nil
for _, e in ipairs(s.find_entities_filtered({ type = "inserter" })) do
    if e.held_stack and e.held_stack.valid_for_read and e.held_stack.name == "railgun-ammo" then
        local c = e.held_stack.count
        total = total + c; n = n + 1; hist[c] = (hist[c] or 0) + 1
        if c <= 2 and not offender then offender = e end
    end
end
local hs = {}; for k, v in pairs(hist) do hs[#hs + 1] = k .. "x" .. v end
rcon.print(string.format("ci_repro railgun-ammo: %d inserters, total held=%d, dist={%s}", n, total, table.concat(hs, " ")))
if offender then
    local e = offender
    rcon.print(string.format("[OFFENDER] %s q=%s @{%.1f,%.1f} active=%s held=%d override=%s filter_mode=%s use_filters=%s",
        e.name, e.quality.name, e.position.x, e.position.y, tostring(e.active), held(e),
        tostring(e.inserter_stack_size_override), tostring(e.inserter_filter_mode), tostring(e.use_filters)))
    rcon.print(string.format("  drop=%s pickup=%s held_pos=%s", tostring(e.drop_position), tostring(e.pickup_position), tostring(e.held_stack_position)))
    -- API sandbox (read back after each)
    local stack = { name = "railgun-ammo", count = 8, quality = "normal" }
    rcon.print("  can_set_stack(8)=" .. tostring(e.held_stack.can_set_stack(stack)))
    local wasA = e.active; e.active = true
    pcall(function() e.held_stack.set_stack(stack) end); rcon.print("  set_stack(8) active -> " .. held(e))
    pcall(function() e.held_stack.count = 8 end); rcon.print("  .count=8 -> " .. held(e))
    e.active = wasA
end
