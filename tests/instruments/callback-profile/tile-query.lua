-- Read-only A/B probe: both algorithms run in the same callback.
return function(platform_index, candidate_first)
  assert(script.active_mods.base == "2.1.17", "engine pin changed")
  local platform
  for _, force in pairs(game.forces) do
    local p = force.platforms[platform_index]
    if p and p.valid then assert(not platform); platform = p end
  end
  assert(platform and platform.surface.valid, "platform missing")
  local surface = platform.surface
  local generated = surface.count_tiles_filtered({})
  assert(generated <= 1048576, "full-query comparison exceeds one million tiles")
  local tick = game.tick
  local function scan(filtered)
    local profiler = helpers.create_profiler()
    local tiles = surface.find_tiles_filtered(filtered and {name = {"out-of-map", "empty-space"}, invert = true} or {})
    local records = {}
    for _, tile in pairs(tiles) do
      if filtered or (tile.name ~= "out-of-map" and tile.name ~= "empty-space") then
        records[#records + 1] = {name = tile.name, x = tile.position.x, y = tile.position.y}
      end
    end
    profiler.stop()
    return records, #tiles, profiler
  end
  local legacy, candidate, legacy_count, candidate_count, legacy_time, candidate_time
  if candidate_first then
    candidate, candidate_count, candidate_time = scan(true)
    legacy, legacy_count, legacy_time = scan(false)
  else
    legacy, legacy_count, legacy_time = scan(false)
    candidate, candidate_count, candidate_time = scan(true)
  end
  assert(#legacy <= 65536 and #candidate <= 65536, "retained tile output exceeds fixture bound")
  assert(game.tick == tick, "comparison crossed ticks")
  rcon.print({"", "[SE_TILE_QUERY]legacy\t", legacy_time})
  rcon.print({"", "[SE_TILE_QUERY]candidate\t", candidate_time})
  return {success = true, engine = script.active_mods.base, platform = platform.name, index = platform.index,
    tick = tick, candidateFirst = candidate_first, generated = generated, legacyQueried = legacy_count,
    candidateQueried = candidate_count, legacy = legacy, candidate = candidate}
end
