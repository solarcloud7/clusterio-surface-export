-- Run the REAL Deserializer on the EXACT CI-failing inserter data (entity_id 16021). If held ends at 1
-- (not 8), reproduced via the real code path; then test API levers on the real entity.
local Deserializer = require("modules/surface_export/core/deserializer")
local sname = "deser_repro"
if game.surfaces[sname] then game.delete_surface(sname) end
local s = game.create_surface(sname, { width = 64, height = 64 })
s.request_to_generate_chunks({ -17, -10 }, 3); s.force_generate_chunk_requests()
local tiles = {}
for x = -26, -6 do for y = -18, -2 do tiles[#tiles + 1] = { name = "refined-concrete", position = { x, y } } end end
s.set_tiles(tiles)
local function held(e) return e.held_stack.valid_for_read and e.held_stack.count or 0 end
local ed = {
    entity_id = 16021, name = "bulk-inserter", type = "inserter",
    position = { x = -17.5, y = -10.5 }, direction = 8, force = "player", health = 400,
    quality = "legendary", orientation = 0.5,
    specific_data = {
        held_item = { name = "railgun-ammo", count = 8, quality = "normal" },
        pickup_position = { x = -17.5, y = -9.5 },
        drop_position = { x = -17.5, y = -11.7 },
        filter_mode = "whitelist", use_filters = false, spoil_priority = "none",
    },
}
local entity = Deserializer.create_entity(s, ed)
if not entity then rcon.print("create_entity returned NIL"); return end
rcon.print(string.format("after create_entity: held=%d active=%s quality=%s drop=%s",
    held(entity), tostring(entity.active), entity.quality.name, tostring(entity.drop_position)))
Deserializer.restore_entity_state(entity, ed)
rcon.print(string.format("after restore_entity_state: held=%d (WANT 8) override=%s",
    held(entity), tostring(entity.inserter_stack_size_override)))
-- API levers on the REAL entity
entity.active = true
local r1 = pcall(function() entity.held_stack.set_stack({ name = "railgun-ammo", count = 8, quality = "normal" }) end)
rcon.print(string.format("set_stack(8) active -> held=%d ok=%s", held(entity), tostring(r1)))
local r2 = pcall(function() entity.held_stack.count = 8 end)
rcon.print(string.format(".count=8 -> held=%d ok=%s", held(entity), tostring(r2)))
entity.active = false
