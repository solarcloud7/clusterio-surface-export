-- Use the test_import_entity remote (real Deserializer path) on the EXACT CI-failing inserter (id 16021).
local sname = "deser_repro"
if game.surfaces[sname] then game.delete_surface(sname) end
local s = game.create_surface(sname, { width = 64, height = 64 })
s.request_to_generate_chunks({ -17, -10 }, 3); s.force_generate_chunk_requests()
local tiles = {}
for x = -26, -6 do for y = -18, -2 do tiles[#tiles + 1] = { name = "refined-concrete", position = { x, y } } end end
s.set_tiles(tiles)
local function held(e) return e and e.valid and e.held_stack.valid_for_read and e.held_stack.count or 0 end
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
local res = remote.call("surface_export", "test_import_entity", ed, s.index)
local e = res.entity
if not (e and e.valid) then
    rcon.print("NO ENTITY. errors=" .. serpent.line(res.errors) .. " warn=" .. serpent.line(res.warnings))
    return
end
rcon.print(string.format("REAL deser: held=%d (WANT 8) active=%s override=%s", held(e), tostring(e.active), tostring(e.inserter_stack_size_override)))
-- API levers on the real entity
e.active = true
pcall(function() e.held_stack.set_stack({ name = "railgun-ammo", count = 8, quality = "normal" }) end)
rcon.print("  set_stack(8) active -> held=" .. held(e))
pcall(function() e.held_stack.count = 8 end)
rcon.print("  .count=8 -> held=" .. held(e))
e.active = false
