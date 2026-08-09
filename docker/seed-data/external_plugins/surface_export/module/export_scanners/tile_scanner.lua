local TileScanner = {}

function TileScanner.scan_surface(surface)
  if not surface or not surface.valid then
    return {}
  end

  local tile_data = {}
  local tiles = surface.find_tiles_filtered({})
  
  for _, tile in pairs(tiles) do
    if tile.name ~= "out-of-map" and tile.name ~= "empty-space" then
      table.insert(tile_data, {
        name = tile.name,
        position = tile.position
      })
    end
  end
  
  return tile_data
end

return TileScanner