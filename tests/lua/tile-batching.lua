local path = "docker/seed-data/external_plugins/surface_export/module/import_phases/tile_restoration.lua"
local calls, fail = {}, false
local env = setmetatable({log = function() end, game = {print = function() end},
    require = function()
        return {place_tiles = function(_, tiles)
            if fail then return 0, #tiles end
            calls[#calls + 1] = tiles
            return #tiles, 0
        end}
    end}, {__index = _G})
local job = {tiles_to_place = {}, target_surface = {}, platform_name = "test"}
for i = 1, 15 do
    job.tiles_to_place[i] = {name = i % 2 == 0 and "space-platform-foundation" or "modded-floor", position = {x = i, y = 0}}
end
local ticks = 0
repeat
    ticks = ticks + 1
    local before = #calls
    local module = assert(loadfile(path, "t", env))()
    module.process(job, 3)
    assert(#calls - before <= 1, "multiple placement calls in one callback")
    if #calls > before then assert(#calls[#calls] <= 3, "tile budget exceeded") end
    assert(ticks <= 10, "never completed")
until job.tiles_placed
assert(ticks == 10 and job.tile_cursor == nil)
local seen, overlay = {}, false
for _, batch in ipairs(calls) do for _, tile in ipairs(batch) do
    if tile.name ~= "space-platform-foundation" then overlay = true else assert(not overlay, "foundation placed after overlay") end
    assert(not seen[tile.position.x], "duplicate tile")
    seen[tile.position.x] = true
end end
for i = 1, 15 do assert(seen[i], "missing tile") end
fail = true
local broken = {tiles_to_place = {{name = "space-platform-foundation"}}, target_surface = {}}
local ok = pcall(assert(loadfile(path, "t", env))().process, broken, 1)
assert(not ok and not broken.tiles_placed, "failed placement advanced to entity creation")
print("PASS bounded tile calls, persisted cursor, exact coverage, global foundation ordering and failure gate")
