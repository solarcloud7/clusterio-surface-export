-- D3 probe: does held_stack.set_stack({name, count=47}) on a (briefly-activated) inserter actually SEAT 47,
-- or truncate to the hand capacity / fail? Mimics restore_held_items_only (active=true -> set_stack -> active=
-- false). Tests bulk vs normal inserter, a high-stack item (iron-plate) vs ammo (railgun-ammo), and empty vs
-- BLOCKED drop target (full chest). One synchronous /sc, no on_tick. NO ground/tick movement (single tick).
local sname = "inserter_lab"
if game.surfaces[sname] then game.delete_surface(sname) end
local s = game.create_surface(sname, { width = 64, height = 32 })
s.request_to_generate_chunks({ 0, 0 }, 2); s.force_generate_chunk_requests()
local tiles = {}
for x = -2, 40 do for y = -2, 6 do tiles[#tiles + 1] = { name = "refined-concrete", position = { x, y } } end end
s.set_tiles(tiles)

-- helper: mimic restore_held_items_only on one inserter, return the post-restore held count + validity
local function try_restore(ins, item, count)
    if not ins then return "NIL_ENTITY" end
    ins.active = false
    local was = ins.active
    ins.active = true
    local ok, err = pcall(function() ins.held_stack.set_stack({ name = item, count = count }) end)
    ins.active = was
    local n = ins.held_stack.valid_for_read and ins.held_stack.count or 0
    return string.format("ok=%s held=%d (wanted %d) err=%s", tostring(ok), n, count, ok and "-" or tostring(err))
end

-- railgun-ammo stack size for reference
local rs = prototypes.item["railgun-ammo"].stack_size
local is = prototypes.item["iron-plate"].stack_size

-- 1) bulk inserter, empty target, railgun-ammo x47
local b1 = s.create_entity({ name = "bulk-inserter", position = { 2.5, 2.5 }, direction = defines.direction.east, force = "player" })
-- 2) bulk inserter, empty target, iron-plate x47
local b2 = s.create_entity({ name = "bulk-inserter", position = { 6.5, 2.5 }, direction = defines.direction.east, force = "player" })
-- 3) normal fast-inserter, empty target, railgun-ammo x47
local b3 = s.create_entity({ name = "fast-inserter", position = { 10.5, 2.5 }, direction = defines.direction.east, force = "player" })
-- 4) bulk inserter, BLOCKED target (full steel-chest in front), railgun-ammo x47
local b4 = s.create_entity({ name = "bulk-inserter", position = { 14.5, 2.5 }, direction = defines.direction.east, force = "player" })
local chest = s.create_entity({ name = "steel-chest", position = { 15.5, 2.5 }, force = "player" })
-- fill the chest completely so the inserter has nowhere to unload
if chest then local inv = chest.get_inventory(defines.inventory.chest); for i = 1, #inv do inv[i].set_stack({ name = "iron-plate", count = is }) end end

storage.inserter_lab = { surface = sname, b1 = b1, b2 = b2, b3 = b3, b4 = b4, chest = chest }

rcon.print(string.format("railgun-ammo stack_size=%d | iron-plate stack_size=%d | bulk capacity bonus=%d", rs, is, game.forces.player.bulk_inserter_capacity_bonus))
rcon.print("1 bulk+railgun47 empty-target: " .. try_restore(b1, "railgun-ammo", 47))
rcon.print("2 bulk+iron47    empty-target: " .. try_restore(b2, "iron-plate", 47))
rcon.print("3 fast+railgun47 empty-target: " .. try_restore(b3, "railgun-ammo", 47))
rcon.print("4 bulk+railgun47 BLOCKED-target(full chest): " .. try_restore(b4, "railgun-ammo", 47))
