-- SUPERSEDED by B6 (run-b6-deactivated-setstack.mjs, 2026-07-18): the active-vs-deactivated A/B this probe frames shows NO difference — activation is not a variable; see NOTEBOOK B6.
-- Reproduce the "seats only 1" bug with the EXACT CI conditions: legendary bulk inserter, held_item dict
-- {name,count=8,quality=normal}, deactivated set_stack (deserializer path) + the API levers.
local sname = "inserter_leg_lab"
if game.surfaces[sname] then game.delete_surface(sname) end
local s = game.create_surface(sname, { width = 32, height = 16 })
s.request_to_generate_chunks({ 0, 0 }, 1); s.force_generate_chunk_requests()
local tiles = {}
for x = -2, 20 do for y = -2, 4 do tiles[#tiles + 1] = { name = "refined-concrete", position = { x, y } } end end
s.set_tiles(tiles)
local function held(e) return e.held_stack.valid_for_read and e.held_stack.count or 0 end
local out = {}
local item = { name = "railgun-ammo", count = 8, quality = "normal" }

-- A) legendary bulk inserter, DEACTIVATED, set_stack (mimics deserializer)
local a = s.create_entity({ name = "bulk-inserter", position = { 2.5, 1.5 }, direction = defines.direction.east, force = "player", quality = "legendary" })
a.active = false
local okA = pcall(function() a.held_stack.set_stack(item) end)
out[#out+1] = string.format("A leg-bulk DEACT set_stack(8) -> held=%d ok=%s", held(a), tostring(okA))

-- B) same but ACTIVE before set_stack
local b = s.create_entity({ name = "bulk-inserter", position = { 5.5, 1.5 }, direction = defines.direction.east, force = "player", quality = "legendary" })
b.active = true
local okB = pcall(function() b.held_stack.set_stack(item) end)
out[#out+1] = string.format("B leg-bulk ACTIVE set_stack(8) -> held=%d ok=%s", held(b), tostring(okB))

-- C) on A (the failing one): try the API levers to seat the full 8
-- C1: nuclear count=
local c1 = pcall(function() a.held_stack.count = 8 end)
out[#out+1] = string.format("C1 A .count=8 -> held=%d ok=%s", held(a), tostring(c1))
-- C2: transfer_stack
local d = s.create_entity({ name = "bulk-inserter", position = { 8.5, 1.5 }, direction = defines.direction.east, force = "player", quality = "legendary" })
d.active = false
pcall(function() d.held_stack.set_stack({ name = "railgun-ammo", count = 1, quality = "normal" }) end)
local before_t = held(d)
local okT, retT = pcall(function() return d.held_stack.transfer_stack({ name = "railgun-ammo", count = 7, quality = "normal" }) end)
out[#out+1] = string.format("C2 transfer_stack(+7) on held=%d -> held=%d ok=%s ret=%s", before_t, held(d), tostring(okT), tostring(retT))
-- C3: active THEN count=
local e = s.create_entity({ name = "bulk-inserter", position = { 11.5, 1.5 }, direction = defines.direction.east, force = "player", quality = "legendary" })
e.active = false
pcall(function() e.held_stack.set_stack(item) end)
e.active = true
local c3 = pcall(function() e.held_stack.count = 8 end)
e.active = false
out[#out+1] = string.format("C3 active+.count=8 -> held=%d ok=%s", held(e), tostring(c3))

for _, l in ipairs(out) do rcon.print(l) end
