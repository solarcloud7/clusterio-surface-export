-- SAVE/LOAD safety gate for the oversized-stack fix (advisor): does a 20-item slot survive a real
-- save + reload, or does the engine clamp the illegal stack to 4 AFTER the pre-save gate already passed?
-- Walled so items can't flow off the end — save/load is the ONLY variable.
local sname = "stackload_s"
if game.surfaces[sname] then game.delete_surface(sname) end
local s = game.create_surface(sname, { width = 16, height = 16 })
s.request_to_generate_chunks({ 0, 0 }, 1); s.force_generate_chunk_requests()
local tiles = {}
for x = -2, 4 do for y = -2, 2 do tiles[#tiles + 1] = { name = "refined-concrete", position = { x, y } } end end
s.set_tiles(tiles)
local belt = s.create_entity({ name = "turbo-transport-belt", position = { 0.5, 0.5 }, direction = defines.direction.east, force = "player" })
s.create_entity({ name = "stone-wall", position = { 1.5, 0.5 }, force = "player" })  -- block the output
local line = belt.get_transport_line(1)
line.clear()
local ok = line.insert_at(0.25, { name = "iron-plate", count = 20 }, 20)
local c = 0
for _, it in ipairs(line.get_detailed_contents()) do c = c + it.stack.count end
storage.stack_load_test = { surface = sname, bx = 0.5, by = 0.5 }
rcon.print(string.format("setup: insert_ok=%s line_count=%d surface=%s (now stop+start the instance)", tostring(ok), c, sname))
