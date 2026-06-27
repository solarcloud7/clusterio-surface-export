-- Advisor check: does a legal force-written held_stack.count survive activation + a tick?
-- (Belt save/load already proven for oversized stacks; held=8 on a legendary bulk is LEGAL, so even safer.)
local sname = "count_persist"
if game.surfaces[sname] then game.delete_surface(sname) end
local s = game.create_surface(sname, { width = 16, height = 16 })
s.request_to_generate_chunks({ 0, 0 }, 1); s.force_generate_chunk_requests()
local tiles = {}
for x = -2, 6 do for y = -2, 4 do tiles[#tiles + 1] = { name = "refined-concrete", position = { x, y } } end end
s.set_tiles(tiles)
local e = s.create_entity({ name = "bulk-inserter", position = { 2.5, 1.5 }, direction = defines.direction.east, force = "player", quality = "legendary" })
local function h() return e.held_stack.valid_for_read and e.held_stack.count or 0 end
-- seat 1 then FORCE count=8 (the fix path)
e.active = false
e.held_stack.set_stack({ name = "railgun-ammo", count = 1, quality = "normal" })
local seated1 = h()
e.held_stack.count = 8
local forced = h()
e.active = true
rcon.print(string.format("seat1=%d  after .count=8 -> %d  active=true (now let server tick; re-run reader)", seated1, forced))
storage.count_persist_e = e
