-- Research: how high can items stack on a belt position? Is 4 the real cap?
local f = game.forces.player
local out = {}
-- Force-level belt stack bonus (Space Age "belt stacking" research raises max items per belt slot).
local ok_b, bonus = pcall(function() return f.belt_stack_size_bonus end)
out[#out + 1] = "belt_stack_size_bonus=" .. (ok_b and tostring(bonus) or "n/a")

-- Build a scratch belt on a fresh surface and probe what one insert_at slot actually accepts.
local sname = "stack_probe_s"
if game.surfaces[sname] then game.delete_surface(sname) end
local s = game.create_surface(sname, { width = 16, height = 16 })
s.request_to_generate_chunks({ 0, 0 }, 1); s.force_generate_chunk_requests()
local tiles = {}
for x = -2, 4 do for y = -2, 2 do tiles[#tiles + 1] = { name = "refined-concrete", position = { x, y } } end end
s.set_tiles(tiles)
local belt = s.create_entity({ name = "turbo-transport-belt", position = { 0.5, 0.5 }, direction = defines.direction.east, force = "player" })
local line = belt.get_transport_line(1)
-- Try inserting a single stack with increasing belt_stack_size; read back the slot's actual stack count.
for _, n in ipairs({ 1, 2, 4, 8, 16 }) do
    line.clear()
    local ok = line.insert_at(0.25, { name = "iron-plate", count = n }, n)
    local got, slot_counts = 0, {}
    for _, it in ipairs(line.get_detailed_contents()) do got = got + it.stack.count; slot_counts[#slot_counts + 1] = it.stack.count end
    out[#out + 1] = string.format("belt_stack_size=%2d insert_ok=%s total_on_line=%d slots=[%s]",
        n, tostring(ok), got, table.concat(slot_counts, ","))
end
game.delete_surface(sname)
rcon.print(table.concat(out, "  ||  "))
