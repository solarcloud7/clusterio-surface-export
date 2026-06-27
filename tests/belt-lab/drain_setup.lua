-- (c) interaction gate: does an inserter PULLING from an oversized stack conserve items, or does the
-- engine shed the illegal overflow when something interacts with it? Belt with a 20-stack, a bulk inserter
-- pulling into a chest. Count belt + inserter-held + chest over real time; must stay 20.
local sname = "drain_s"
if game.surfaces[sname] then game.delete_surface(sname) end
local s = game.create_surface(sname, { width = 16, height = 16 })
s.request_to_generate_chunks({ 0, 0 }, 1); s.force_generate_chunk_requests()
local tiles = {}
for x = -3, 4 do for y = -3, 4 do tiles[#tiles + 1] = { name = "refined-concrete", position = { x, y } } end end
s.set_tiles(tiles)
local belt = s.create_entity({ name = "turbo-transport-belt", position = { 0.5, 0.5 }, direction = defines.direction.east, force = "player" })
s.create_entity({ name = "stone-wall", position = { 1.5, 0.5 }, force = "player" })       -- jam the stack in place
local chest = s.create_entity({ name = "steel-chest", position = { 0.5, -1.5 }, force = "player" })
-- inserter at (0.5,-0.5) facing north: picks from behind (0.5,0.5)=belt, drops front (0.5,-1.5)=chest.
local ins = s.create_entity({ name = "bulk-inserter", position = { 0.5, -0.5 }, direction = defines.direction.north, force = "player" })
local line = belt.get_transport_line(1)
line.clear()
local ok = line.insert_at(0.25, { name = "iron-plate", count = 20 }, 20)
storage.drain_test = { surface = sname, bx = 0.5, by = 0.5, cx = 0.5, cy = -1.5, ix = 0.5, iy = -0.5 }
rcon.print(string.format("drain setup: insert_ok=%s line=%d chest=%s inserter=%s", tostring(ok), line.get_item_count(), tostring(chest ~= nil), tostring(ins ~= nil)))
