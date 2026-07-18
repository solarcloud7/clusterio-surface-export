-- SUPERSEDED by B6 (run-b6-deactivated-setstack.mjs, 2026-07-18): the active-vs-deactivated A/B this probe frames shows NO difference — activation is not a variable; see NOTEBOOK B6.
-- Fix-approach probe: reproduce the under-fill (set_stack on a deactivated bulk inserter) and verify the
-- top-up fix (clear + briefly-active set_stack the FULL captured count) reaches the full amount.
local sname = "inserter_fix_lab"
if game.surfaces[sname] then game.delete_surface(sname) end
local s = game.create_surface(sname, { width = 32, height = 16 })
s.request_to_generate_chunks({ 0, 0 }, 1); s.force_generate_chunk_requests()
local tiles = {}
for x = -2, 20 do for y = -2, 4 do tiles[#tiles + 1] = { name = "refined-concrete", position = { x, y } } end end
s.set_tiles(tiles)

local function held(ins) return ins.held_stack.valid_for_read and ins.held_stack.count or 0 end

-- A) set_stack on a freshly-created DEACTIVATED bulk inserter (mimics the deserializer bug)
local a = s.create_entity({ name = "bulk-inserter", position = { 2.5, 1.5 }, direction = defines.direction.east, force = "player" })
a.active = false
pcall(function() a.held_stack.set_stack({ name = "railgun-ammo", count = 10 }) end)
local a_after_create = held(a)

-- B) THE FIX applied to A's (possibly partial) hand: clear + briefly active + set_stack FULL count
local function topup(ins, item, want)
    if held(ins) >= want then return held(ins) end
    local was = ins.active
    ins.active = true
    pcall(function() ins.held_stack.clear() end)
    pcall(function() ins.held_stack.set_stack({ name = item, count = want }) end)
    ins.active = was
    return held(ins)
end
local a_after_fix = topup(a, "railgun-ammo", 10)

-- C) set_stack on a freshly-created ACTIVE bulk inserter (control)
local c = s.create_entity({ name = "bulk-inserter", position = { 6.5, 1.5 }, direction = defines.direction.east, force = "player" })
pcall(function() c.held_stack.set_stack({ name = "railgun-ammo", count = 10 }) end)
local c_active = held(c)

rcon.print(string.format("A deactivated-create set_stack(10) -> held=%d (bug if <10)", a_after_create))
rcon.print(string.format("B fix top-up (clear+active+set_stack) -> held=%d (want 10)", a_after_fix))
rcon.print(string.format("C active-create set_stack(10) -> held=%d (control)", c_active))
