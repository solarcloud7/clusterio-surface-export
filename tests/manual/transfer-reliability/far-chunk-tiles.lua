local PREFIX = "transfer-cleanup-"
local FOUNDATION = "space-platform-foundation"
local CHUNKS = {x = {-3, 2}, y = {-2, 10}}

local function find(name)
  local found
  for _, p in pairs(game.forces.player.platforms) do
    if p.valid and p.name == name then
      assert(not found, "ambiguous fixture name")
      found = p
    end
  end
  return found
end

local function chunk_area(cx, cy)
  return {{cx * 32, cy * 32}, {cx * 32 + 32, cy * 32 + 32}}
end

local function census(surface)
  local chunks, total, ungenerated = {}, 0, {}
  for cx = CHUNKS.x[1], CHUNKS.x[2] do
    for cy = CHUNKS.y[1], CHUNKS.y[2] do
      local generated = surface.is_chunk_generated({cx, cy})
      local count = surface.count_tiles_filtered({area = chunk_area(cx, cy), name = FOUNDATION})
      if count > 0 then
        chunks[cx .. "," .. cy] = count
        total = total + count
        if not generated then ungenerated[#ungenerated + 1] = cx .. "," .. cy end
      end
    end
  end
  return {total = total, surface_total = surface.count_tiles_filtered({name = FOUNDATION}), chunks = chunks,
    ungenerated_with_tiles = ungenerated}
end

local function generate_all(surface)
  for cx = CHUNKS.x[1], CHUNKS.x[2] do
    for cy = CHUNKS.y[1], CHUNKS.y[2] do
      surface.request_to_generate_chunks({cx * 32 + 16, cy * 32 + 16}, 0)
    end
  end
  surface.force_generate_chunk_requests()
end

local function fill_chunk(surface, cx, cy)
  local tiles = {}
  for x = cx * 32, cx * 32 + 31 do
    for y = cy * 32, cy * 32 + 31 do tiles[#tiles + 1] = {name = FOUNDATION, position = {x, y}} end
  end
  surface.set_tiles(tiles)
  return #tiles
end

local function count_chunk(surface, cx, cy)
  return surface.count_tiles_filtered({area = chunk_area(cx, cy), name = FOUNDATION})
end

return function(action, name)
  assert(type(name) == "string" and name:sub(1, #PREFIX) == PREFIX and name:match("^[%w-]+$"), "invalid fixture scope")
  if action == "engine" then
    assert(not find(name), "fixture already exists")
    local p = assert(game.forces.player.create_space_platform{name = name, planet = "nauvis",
      starter_pack = "space-platform-starter-pack"})
    p.apply_starter_pack()
    p.paused = true
    local s = p.surface
    local late = {chunk = {0, 8}, generated_before = s.is_chunk_generated({0, 8})}
    late.placed = fill_chunk(s, 0, 8)
    late.after_set = count_chunk(s, 0, 8)
    late.generated_after_set = s.is_chunk_generated({0, 8})
    s.request_to_generate_chunks({16, 8 * 32 + 16}, 0)
    s.force_generate_chunk_requests()
    late.generated_after_request = s.is_chunk_generated({0, 8})
    late.after_generation = count_chunk(s, 0, 8)
    local first = {chunk = {2, 8}, generated_before = s.is_chunk_generated({2, 8})}
    s.request_to_generate_chunks({2 * 32 + 16, 8 * 32 + 16}, 0)
    s.force_generate_chunk_requests()
    first.generated_after_request = s.is_chunk_generated({2, 8})
    first.placed = fill_chunk(s, 2, 8)
    first.after_set = count_chunk(s, 2, 8)
    s.request_to_generate_chunks({2 * 32 + 16, 8 * 32 + 16}, 1)
    s.force_generate_chunk_requests()
    first.after_neighbour_generation = count_chunk(s, 2, 8)
    return {success = true, platform = p.index, surface = s.index, late = late, generate_first = first}
  elseif action == "cost" then
    local p = assert(find(name), "fixture missing")
    local s, ungenerated = p.surface, 0
    for cx = -2, 1 do
      for cy = 20, 32 do
        if not s.is_chunk_generated({cx, cy}) then ungenerated = ungenerated + 1 end
        s.request_to_generate_chunks({cx * 32 + 16, cy * 32 + 16}, 0)
      end
    end
    local profiler = helpers.create_profiler()
    s.force_generate_chunk_requests()
    profiler.stop()
    rcon.print({"", "COST ungenerated=", ungenerated, " ", profiler})
    return {success = true, ungenerated = ungenerated}
  elseif action == "extend" then
    local p = assert(find(name), "fixture missing")
    local s = p.surface
    for cx = -2, 1 do
      for cy = 0, 9 do s.request_to_generate_chunks({cx * 32 + 16, cy * 32 + 16}, 0) end
    end
    s.force_generate_chunk_requests()
    for y = 9, 299 do
      local row = {}
      for x = -64, 63 do row[#row + 1] = {name = FOUNDATION, position = {x, y}} end
      s.set_tiles(row)
    end
    local chest = assert(s.create_entity{name = "steel-chest", position = {-40.5, 280.5}, force = "player"})
    assert(chest.insert{name = "iron-plate", count = 7} == 7)
    return {success = true, census = census(s)}
  elseif action == "census" then
    local p = find(name)
    if not p then return {success = true, present = false} end
    local chest = p.surface.find_entities_filtered{name = "steel-chest", area = {{-41, 280}, {-40, 281}}}[1]
    return {success = true, present = true, census = census(p.surface),
      far_chest = chest and chest.get_item_count("iron-plate") or nil}
  elseif action == "gate" then
    local validation = assert(package.loaded["__level__/modules/surface_export/validators/transfer-validation.lua"],
      "transfer validation not loaded")
    assert(not find(name), "fixture already exists")
    local p = assert(game.forces.player.create_space_platform{name = name, planet = "nauvis",
      starter_pack = "space-platform-starter-pack"})
    p.apply_starter_pack()
    p.paused = true
    local s = p.surface
    for _, e in pairs(s.find_entities_filtered{}) do
      if e.name ~= "space-platform-hub" then e.destroy() end
    end
    for i = 1, p.hub.get_max_inventory_index() do
      local inv = p.hub.get_inventory(i)
      if inv then inv.clear() end
    end
    local payload = {}
    for _, tile in pairs(s.find_tiles_filtered{name = FOUNDATION}) do
      payload[#payload + 1] = {name = FOUNDATION, position = tile.position}
    end
    local far = {}
    for x = 0, 31 do
      for y = 8 * 32, 8 * 32 + 31 do far[#far + 1] = {name = FOUNDATION, position = {x = x, y = y}} end
    end
    for _, tile in ipairs(far) do payload[#payload + 1] = tile end
    local function check()
      local ok, r = validation.validate_import(s, {item_counts = {}, fluid_counts = {}, tiles = payload}, {strict = true})
      return {success = ok, failedStage = r.failedStage, tileCountMatch = r.tileCountMatch,
        ungeneratedTileChunks = r.ungeneratedTileChunks, tileLossByType = r.tileLossByType,
        expected = r.expectedTileCounts, actual = r.actualTileCounts, details = r.mismatchDetails}
    end
    local generated_before = s.is_chunk_generated({0, 8})
    s.set_tiles(far)
    local pending = check()
    s.request_to_generate_chunks({16, 8 * 32 + 16}, 0)
    s.force_generate_chunk_requests()
    local wiped = check()
    s.set_tiles(far)
    local restored = check()
    return {success = true, payload = #payload, generated_before = generated_before, pending = pending,
      wiped = wiped, restored = restored}
  elseif action == "generate" then
    local p = assert(find(name), "fixture missing")
    generate_all(p.surface)
    return {success = true, census = census(p.surface)}
  end
  error("unknown action " .. tostring(action))
end
