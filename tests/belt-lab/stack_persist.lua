-- CRITICAL safety test: does an over-sized belt stack (>4) SURVIVE belt flow, or does the engine
-- clamp it back to 4 on the next tick (= silent loss)? Build a belt, insert a 16-stack, store handles.
-- A follow-up read after real-time flow tells us if it persisted.
local sname = "stack_persist_s"
if game.surfaces[sname] then game.delete_surface(sname) end
local s = game.create_surface(sname, { width = 16, height = 16 })
s.request_to_generate_chunks({ 0, 0 }, 1); s.force_generate_chunk_requests()
local tiles = {}
for x = -2, 6 do for y = -2, 2 do tiles[#tiles + 1] = { name = "refined-concrete", position = { x, y } } end end
s.set_tiles(tiles)
-- 3-belt chain east, wall at the end so items can't leave (flow but no exit).
local belts = {}
for x = 0, 2 do belts[#belts + 1] = s.create_entity({ name = "turbo-transport-belt", position = { x + 0.5, 0.5 }, direction = defines.direction.east, force = "player" }) end
s.create_entity({ name = "stone-wall", position = { 3.5, 0.5 }, force = "player" })
storage.stack_persist = { surface = sname, belts = belts }
-- Over-compression scenario: put 20 iron-plate on the FIRST belt's line 1 (len ~1.0) as a SINGLE consolidated
-- stack and as a few tall stacks, vs the natural 5×4. Record immediate counts.
local line = belts[1].get_transport_line(1)
line.clear()
local ok1 = line.insert_at(0.25, { name = "iron-plate", count = 20 }, 20)   -- one 20-stack
local immediate = 0
for _, it in ipairs(line.get_detailed_contents()) do immediate = immediate + it.stack.count end
rcon.print(string.format("immediate: insert20_ok=%s line_count=%d (will re-read after flow)", tostring(ok1), immediate))
