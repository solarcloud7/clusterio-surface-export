local root = "docker/seed-data/external_plugins/surface_export/module/"
local FOUNDATION = "space-platform-foundation"
local function noop() end
local function count(t) local n = 0 for _ in pairs(t or {}) do n = n + 1 end return n end
local function sum(t) local n = 0 for _, v in pairs(t or {}) do n = n + v end return n end

local function chunk_of(x, y) return math.floor(x / 32), math.floor(y / 32) end

local function fake_surface(generated)
	local surface = {valid = true, tiles = {}, generated = {}, requested = {}, generations = 0}
	local function key(cx, cy) return cx .. "," .. cy end
	for _, chunk in ipairs(generated or {}) do surface.generated[key(chunk[1], chunk[2])] = true end
	local function position(p) return p.x or p[1], p.y or p[2] end
	function surface.set_tiles(tiles)
		for _, tile in ipairs(tiles) do
			local x, y = position(tile.position)
			surface.tiles[x .. ":" .. y] = tile.name
		end
	end
	function surface.is_chunk_generated(chunk)
		local cx, cy = position(chunk)
		return surface.generated[key(cx, cy)] == true
	end
	function surface.request_to_generate_chunks(p, radius)
		assert((radius or 0) == 0, "test model requests one chunk at a time")
		local x, y = position(p)
		local cx, cy = chunk_of(x, y)
		surface.requested[key(cx, cy)] = {cx, cy}
	end
	surface.force_batches = {}
	function surface.force_generate_chunk_requests()
		local batch = 0
		for _ in pairs(surface.requested) do batch = batch + 1 end
		surface.force_batches[#surface.force_batches + 1] = batch
		for k, chunk in pairs(surface.requested) do
			if not surface.generated[k] then
				surface.generations = surface.generations + 1
				for x = chunk[1] * 32, chunk[1] * 32 + 31 do
					for y = chunk[2] * 32, chunk[2] * 32 + 31 do surface.tiles[x .. ":" .. y] = nil end
				end
				surface.generated[k] = true
			end
		end
		surface.requested = {}
	end
	function surface.count_tiles_filtered(filter)
		local n, area = 0, filter.area
		local names = type(filter.name) == "table" and filter.name or {filter.name}
		local wanted = {}
		for _, name in ipairs(names) do wanted[name] = true end
		for k, name in pairs(surface.tiles) do
			local x, y = k:match("^(-?%d+):(-?%d+)$")
			x, y = tonumber(x), tonumber(y)
			if wanted[name] and (not area or (x >= area[1][1] and x < area[2][1] and y >= area[1][2] and y < area[2][2])) then
				n = n + 1
			end
		end
		return n
	end
	function surface.find_entities_filtered() return {} end
	return surface
end

local function payload_tiles()
	local tiles = {}
	for x = -8, 7 do
		for y = -8, 71 do tiles[#tiles + 1] = {name = FOUNDATION, position = {x = x, y = y}} end
	end
	tiles[#tiles + 1] = {name = "modded-floor", position = {x = 8, y = 70}}
	return tiles
end

local function load_tile_restoration()
	local env = setmetatable({log = noop}, {__index = _G})
	env.require = function(path)
		if path == "modules/surface_export/core/deserializer" then
			return {place_tiles = function(surface, tiles)
				surface.set_tiles(tiles)
				return #tiles, 0
			end}
		elseif path == "modules/surface_export/utils/operation-timing" then
			return {start = noop, stop = noop, fail = noop, scope = function(_, _, fn, ...) return fn(...) end}
		end
		error("unexpected require " .. tostring(path))
	end
	return assert(loadfile(root .. "import_phases/tile_restoration.lua", "t", env))()
end

local function restore(surface, tiles, entities, fields)
	local job = {job_id = "job", tiles_to_place = tiles, entities_to_create = entities or {}, target_surface = surface, metrics = {}}
	for k, v in pairs(fields or {}) do job[k] = v end
	local module = load_tile_restoration()
	for _ = 1, 200 do
		if module.process(job, 1000) then return job end
	end
	error("tile restoration never completed")
end

local function generate_everything(surface)
	for cx = -3, 3 do
		for cy = -3, 4 do surface.request_to_generate_chunks({cx * 32 + 16, cy * 32 + 16}, 0) end
	end
	surface.force_generate_chunk_requests()
end

local hub_chunks = {{-1, -1}, {0, -1}, {-1, 0}, {0, 0}}
local tiles = payload_tiles()

local control = fake_surface(hub_chunks)
control.set_tiles(tiles)
generate_everything(control)
assert(control.count_tiles_filtered({name = FOUNDATION}) == 16 * 40, "control must lose every tile outside the hub chunks")
print("CONTROL set_tiles before generation: " .. control.count_tiles_filtered({name = FOUNDATION}) .. " of " .. (#tiles - 1) .. " foundation tiles survive")

local surface = fake_surface(hub_chunks)
local far_entity = {name = "steel-chest", position = {x = 40.5, y = 100.5}}
local job = restore(surface, tiles, {far_entity})
assert(job.tiles_placed, "tiles were not placed")
for cx = -1, 0 do
	for cy = -1, 2 do assert(surface.is_chunk_generated({cx, cy}), "payload tile chunk " .. cx .. "," .. cy .. " not generated") end
end
assert(surface.is_chunk_generated({1, 3}), "payload entity chunk not generated")
generate_everything(surface)
assert(surface.count_tiles_filtered({name = FOUNDATION}) == #tiles - 1, "tiles lost when remaining chunks generated")
assert(surface.count_tiles_filtered({name = "modded-floor"}) == 1, "overlay tile lost")
print("PASS restoration generates payload chunks before set_tiles; later generation keeps all " .. #tiles .. " tiles")

local wide_tiles = {}
for cx = -4, 4 do
	for cy = -4, 4 do wide_tiles[#wide_tiles + 1] = {name = FOUNDATION, position = {x = cx * 32 + 5, y = cy * 32 + 5}} end
end
local wide = fake_surface(hub_chunks)
restore(wide, wide_tiles)
local most = 0
for _, n in ipairs(wide.force_batches) do most = math.max(most, n) end
assert(#wide.force_batches >= 3 and most <= 32, "chunk generation not bounded per callback: " .. #wide.force_batches .. " batches, max " .. most)
assert(wide.count_tiles_filtered({name = FOUNDATION}) == #wide_tiles, "batched generation lost tiles")
print("PASS chunk generation spans " .. #wide.force_batches .. " callbacks of at most 32 chunks")

local resumed = fake_surface(hub_chunks)
local half = math.floor(#tiles / 2)
local already = {}
for i = 1, half do already[i] = tiles[i] end
resumed.set_tiles(already)
restore(resumed, tiles, nil, {tile_cursor = {index = half + 1, foundation = true, placed = half, failed = 0}})
generate_everything(resumed)
assert(resumed.count_tiles_filtered({name = FOUNDATION}) == #tiles - 1, "tiles placed before an upgrade were lost on resume")
print("PASS a job resumed mid-placement re-places tiles after generating chunks")

local stuck = fake_surface(hub_chunks)
stuck.force_generate_chunk_requests = function() stuck.requested = {} end
local ok, err = pcall(restore, stuck, tiles)
assert(not ok and tostring(err):find("not generated"), "ungenerated chunk did not stop restoration: " .. tostring(err))
assert(next(stuck.tiles) == nil, "tiles placed into an ungenerated chunk")
print("PASS ungenerated chunk stops restoration before placement")

local cache = {}
local env = setmetatable({storage = {surface_export_config = {}}, game = {tick = 100, print = noop}, log = noop,
	table_size = count}, {__index = _G})
local function loadmod(name)
	if cache[name] then return cache[name] end
	local m = assert(loadfile(root .. name .. ".lua", "t", env))()
	cache[name] = m
	return m
end
env.require = function(path)
	local name = path:match("^modules/surface_export/(.*)$")
	if not name then return {} end
	return loadmod(name)
end
cache["utils/version-compat"] = {}
local gu = loadmod("utils/game-utils")
cache["utils/util"] = {QUALITY_NORMAL = "normal", HIGH_TEMP_THRESHOLD = 10000, make_quality_key = gu.make_quality_key,
	make_fluid_temp_key = gu.make_fluid_temp_key, parse_fluid_temp_key = gu.parse_fluid_temp_key, sum_items = sum, sum_fluids = sum}
cache["export_scanners/fluid-registry"] = {}
cache["utils/operation-timing"] = {start = noop, stop = noop, fail = noop, finish = noop}
local validation = loadmod("validators/transfer-validation")
local function validate(target)
	return validation.validate_import(target, {item_counts = {}, fluid_counts = {}, tiles = tiles}, {strict = true})
end

local passed, result = validate(surface)
assert(passed == true and result.success == true, "complete destination failed validation: " .. tostring(result.mismatchDetails))
assert(result.expectedTileCounts[FOUNDATION] == #tiles - 1 and result.actualTileCounts[FOUNDATION] == #tiles - 1)
assert(result.tileCountMatch == true)
print("PASS complete tile census validates")

local lost = fake_surface(hub_chunks)
lost.set_tiles(tiles)
generate_everything(lost)
passed, result = validate(lost)
assert(passed == false and result.success == false and result.failedStage == "tiles", "lost tiles passed validation")
assert(result.tileCountMatch == false and result.actualTileCounts[FOUNDATION] == 16 * 40)
assert(tostring(result.mismatchDetails):find("Tile mismatches"), "missing tile mismatch details")
print("PASS lost tiles fail validation: " .. result.mismatchDetails:sub(1, 160))

local pending = fake_surface(hub_chunks)
pending.set_tiles(tiles)
passed, result = validate(pending)
assert(pending.count_tiles_filtered({name = FOUNDATION}) == #tiles - 1, "fixture must still show every tile")
assert(passed == false and result.failedStage == "tiles", "tiles in ungenerated chunks passed validation")
assert(tostring(result.mismatchDetails):find("not generated"), "ungenerated chunk not reported")
assert(pending.generations == 0, "validation generated chunks")
print("PASS tiles in ungenerated chunks fail validation without generating them")

local offset = fake_surface({{-1, -1}, {0, -1}, {-1, 0}, {0, 0}, {-1, 1}, {0, 1}, {-1, 2}, {0, 2}})
offset.set_tiles(tiles)
local moved = {}
for x = -8, 7 do
	offset.tiles[x .. ":" .. 71] = nil
	moved[#moved + 1] = {name = FOUNDATION, position = {x = x + 16, y = 0}}
end
offset.set_tiles(moved)
assert(offset.count_tiles_filtered({name = FOUNDATION}) == #tiles - 1, "fixture must keep the global count")
passed, result = validate(offset)
assert(passed == false and result.failedStage == "tiles", "a chunk loss offset by a gain elsewhere passed validation")
print("PASS a loss in one chunk is not hidden by a gain in another")

local gained = fake_surface({{-1, -1}, {0, -1}, {-1, 0}, {0, 0}, {-1, 1}, {0, 1}, {-1, 2}, {0, 2}})
gained.set_tiles(tiles)
gained.set_tiles({{name = FOUNDATION, position = {x = 9, y = 0}}})
passed, result = validate(gained)
assert(passed == true and result.tileGains and result.tileGains[FOUNDATION] == 1, "extra destination tile not reported")
print("PASS extra destination tiles are reported without failing validation")

passed, result = validation.validate_import(surface, {item_counts = {}, fluid_counts = {}}, {strict = true})
assert(passed == true and result.expectedTileCounts == nil, "payload without tiles must skip the tile census")
print("PASS payload without tile expectations skips the census")
