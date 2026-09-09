local TileScanner = {}

function TileScanner.scan_surface(surface)
  if not surface or not surface.valid then
    return {}
  end

  local tile_data = {}
  -- Exclude void tiles in the engine, before returning them to Lua.
  -- Invert the exclusions rather than listing allowed tiles, preserving modded tiles.
  local tiles = surface.find_tiles_filtered({name = {"out-of-map", "empty-space"}, invert = true})
  
  for _, tile in pairs(tiles) do
    table.insert(tile_data, {
      name = tile.name,
      position = tile.position
    })
  end
  
  return tile_data
end

return TileScanner
