local root = "docker/seed-data/external_plugins/surface_export/module/"
local noop = function() end
local logged = {}
local env = setmetatable({storage = {}, game = {tick = 1}, log = function(line) logged[#logged + 1] = line end,
    defines = {inventory = {item_main = 1}}}, {__index = _G})
env.require = function(name)
    if name:find("utils/util", 1, true) then return {QUALITY_NORMAL = "normal", pcall_warn = function(_, fn) fn() end} end
    return {}
end
local scanner = assert(loadfile(root .. "export_scanners/inventory-scanner.lua", "t", env))()

local reads = {}
local function fake_stack(name, values, unsupported, flags)
    local base = {valid_for_read = true, name = name, count = 1, quality = {name = "normal"}, prototype = {type = "item"},
        is_blueprint = false, is_blueprint_book = false, is_upgrade_item = false, is_deconstruction_item = false,
        is_item_with_tags = false, is_item_with_label = false, is_item_with_inventory = false}
    for key, value in pairs(flags or {}) do base[key] = value end
    return setmetatable({}, {__index = function(_, key)
        reads[name .. "." .. key] = (reads[name .. "." .. key] or 0) + 1
        if base[key] ~= nil then return base[key] end
        if unsupported[key] then error(key .. " is not available on " .. name) end
        return values[key]
    end})
end
local function count(key) return reads[key] or 0 end
local function same(a, b)
    if type(a) ~= "table" or type(b) ~= "table" then return a == b end
    for k, v in pairs(a) do if not same(v, b[k]) then return false end end
    for k in pairs(b) do if a[k] == nil then return false end end
    return true
end

do
    local plate = {health = 1}
    local off = {durability = true, ammo = true, custom_description = true}
    local entries = {}
    for i = 1, 3 do entries[i] = scanner.extract_item_properties(fake_stack("iron-plate", plate, off)) end
    for i = 1, 3 do assert(same(entries[i], {name = "iron-plate", count = 1, quality = "normal", health = 1}), "plate " .. i .. " changed") end
    assert(count("iron-plate.durability") == 1 and count("iron-plate.ammo") == 1 and count("iron-plate.custom_description") == 1,
        "a read that throws for an item was repeated on a later stack of that item")
    assert(count("iron-plate.health") == 3 and count("iron-plate.spoil_percent") == 3 and count("iron-plate.grid") == 3,
        "a supported read was skipped on a later stack")
    assert(count("iron-plate.is_blueprint") == 1 and count("iron-plate.is_item_with_label") == 1 and count("iron-plate.prototype") == 1,
        "prototype facts were re-read per stack")
    assert(#logged == 3 and logged[1]:find("iron-plate does not support durability", 1, true), "the first skipped read was not logged")
    for i = 1, 2 do scanner.extract_item_properties(fake_stack("wood", {health = 1}, {})) end
    assert(count("wood.durability") == 2 and count("wood.is_blueprint") == 1 and count("wood.is_item_with_inventory") == 1
        and count("wood.prototype") == 1, "prototype facts were re-read for an item whose reads never throw")
    assert(#logged == 3, "a read that does not throw was logged as skipped")
    print("PASS an unsupported attribute is probed once per item name; supported ones are read on every stack")
end

do
    local none = scanner.extract_item_properties(fake_stack("modular-armor", {health = 1, grid = {valid = true, equipment = false}}, {ammo = true}))
    assert(none.grid == nil, "a grid without equipment was captured")
    local fitted = scanner.extract_item_properties(fake_stack("modular-armor", {health = 1, grid = {valid = true, equipment = {}}}, {ammo = true}))
    assert(type(fitted.grid) == "table", "a grid with equipment was not captured on a later stack of the same item")
    local exported = 0
    local tagged = fake_stack("blueprint", {health = 1}, {durability = true, ammo = true}, {is_item_with_tags = true,
        export_stack = function() exported = exported + 1 return "EXPORTED" end})
    assert(scanner.extract_item_properties(tagged).export_string == "EXPORTED" and exported == 1, "an item with tags was not exported")
    assert(scanner.extract_item_properties(tagged).export_string == "EXPORTED" and exported == 2, "the export was skipped on a later stack")
    print("PASS grids are captured per stack and tagged items are exported on every stack")
end

do
    local mag = {ammo = 5, health = 1}
    local first = scanner.extract_item_properties(fake_stack("firearm-magazine", mag, {durability = true, custom_description = true}))
    local second = scanner.extract_item_properties(fake_stack("firearm-magazine", {ammo = 2, health = 0.5}, {durability = true, custom_description = true}))
    assert(first.ammo == 5 and second.ammo == 2 and second.health == 0.5, "per-stack values were not read for a supported attribute")
    assert(count("firearm-magazine.ammo") == 2 and count("firearm-magazine.durability") == 1, "item names did not get their own probes")
    assert(count("iron-plate.ammo") == 1, "another item's outcome leaked across names")
    local tool = scanner.extract_item_properties(fake_stack("repair-pack", {durability = 0.25, health = 1}, {ammo = true, custom_description = true}))
    assert(tool.durability == 0.25 and tool.ammo == nil)
    print("PASS attribute values stay per stack while the throw outcome is per item name")
end

do
    scanner.forget_item_kinds()
    scanner.extract_item_properties(fake_stack("iron-plate", {health = 1}, {durability = true, ammo = true, custom_description = true}))
    assert(count("iron-plate.durability") == 2 and count("iron-plate.is_blueprint") == 2, "forgetting item kinds did not re-probe")
    print("PASS forgetting item kinds re-probes every attribute")
end
