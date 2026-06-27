-- Phase 1a: build a clean OVER-COMPRESSION fixture (no geometry mismatch).
-- Straight turbo-belt chain facing EAST, output blocked by a wall so items back up and
-- compress past insert_at's 0.25 min spacing via real belt FLOW (not insert_at). Same line_length
-- everywhere (all straight) => isolates over-compression from the corner/length-mismatch subset.
-- Safe: ONE synchronous /sc, no on_tick handler. Belt flow happens between RCON calls (live server).
local CHAIN = 6                 -- belt tiles
local ITEM = "iron-plate"
local sname = "belt_lab_mt"
if game.surfaces[sname] then game.delete_surface(sname) end
local s = game.create_surface(sname, { width = 64, height = 64 })
s.request_to_generate_chunks({0, 0}, 2)
s.force_generate_chunk_requests()
-- Lay solid tiles so belts can be placed on a normal surface.
local tiles = {}
for x = -2, CHAIN + 4 do for y = -2, 4 do tiles[#tiles + 1] = { name = "refined-concrete", position = { x, y } } end end
s.set_tiles(tiles)
storage.belt_lab = { surface = sname, item = ITEM, chain = CHAIN, belts = {} }
-- Build the chain at y=0, x=0..CHAIN-1, facing EAST. Wall at x=CHAIN blocks the output.
for x = 0, CHAIN - 1 do
    local b = s.create_entity({ name = "turbo-transport-belt", position = { x + 0.5, 0.5 }, direction = defines.direction.east, force = "player" })
    if b then storage.belt_lab.belts[#storage.belt_lab.belts + 1] = b end
end
local wall = s.create_entity({ name = "stone-wall", position = { CHAIN + 0.5, 0.5 }, force = "player" })
rcon.print(string.format("setup: surface=%s belts=%d wall=%s", sname, #storage.belt_lab.belts, tostring(wall ~= nil)))
