local scanner = assert(loadfile("docker/seed-data/external_plugins/surface_export/module/export_scanners/tile_scanner.lua"))()
assert(#scanner.scan_surface(nil) == 0)
assert(#scanner.scan_surface({valid = false}) == 0)
for _, tiles in ipairs({{}, {
    {name = "space-platform-foundation", position = {x = -1, y = 2}},
    {name = "modded-floor", position = {x = 3, y = -4}},
    {name = "water", position = {x = 5, y = 6}},
}}) do
    local calls = 0
    local result = scanner.scan_surface({valid = true, find_tiles_filtered = function(filters)
        calls = calls + 1
        assert(filters.invert == true and #filters.name == 2)
        assert(filters.name[1] == "out-of-map" and filters.name[2] == "empty-space")
        assert(filters.area == nil and filters.limit == nil, "scan must not omit distant tiles or truncate")
        return tiles
    end})
    assert(calls == 1 and #result == #tiles)
    for index, tile in ipairs(tiles) do
        assert(result[index].name == tile.name)
        assert(result[index].position.x == tile.position.x and result[index].position.y == tile.position.y)
    end
end
print("PASS inverted void exclusion, complete projection, modded tiles, empty and invalid surfaces")
