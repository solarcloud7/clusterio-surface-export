local Deserializer = require("modules/surface_export/core/deserializer")
local Timing = require("modules/surface_export/utils/operation-timing")
local TileRestoration = {}

local function covered_chunks(job)
    local seen, chunks = {}, {}
    local function add(position)
        local x = position and (position.x or position[1])
        local y = position and (position.y or position[2])
        if type(x) ~= "number" or type(y) ~= "number" then return end
        local cx, cy = math.floor(x / 32), math.floor(y / 32)
        local column = seen[cx]
        if not column then
            column = {}
            seen[cx] = column
        end
        if not column[cy] then
            column[cy] = true
            chunks[#chunks + 1] = {cx, cy}
        end
    end
    for _, tile in ipairs(job.tiles_to_place or {}) do add(tile.position) end
    for _, entity in ipairs(job.entities_to_create or {}) do add(entity.position) end
    return chunks
end

local function generate_chunks(surface, chunks)
    local requested = 0
    for _, chunk in ipairs(chunks) do
        if not surface.is_chunk_generated(chunk) then
            surface.request_to_generate_chunks({chunk[1] * 32 + 16, chunk[2] * 32 + 16}, 0)
            requested = requested + 1
        end
    end
    if requested > 0 then surface.force_generate_chunk_requests() end
    for _, chunk in ipairs(chunks) do
        if not surface.is_chunk_generated(chunk) then
            error(string.format("Chunk %d,%d not generated; import stopped before tile placement", chunk[1], chunk[2]))
        end
    end
    return requested
end

function TileRestoration.process(job, budget)
    if job.tiles_placed then
        return true
    end

    if not job.tile_chunks_generated then
        Timing.start(job.job_id, "chunk_generation", "execution", "tiles")
        local chunks = covered_chunks(job)
        local ok, requested = pcall(generate_chunks, job.target_surface, chunks)
        Timing.stop(job.job_id, "chunk_generation")
        if not ok then
            Timing.fail(job.job_id, "chunk_generation")
            error(requested, 0)
        end
        job.tile_chunks_generated = true
        log(string.format("[FactorioSurfaceExport] Payload chunks before tile placement: covered=%d, generated=%d",
            #chunks, requested))
        return false
    end

    budget = math.max(1, math.floor(budget or 1000))
    local tiles = job.tiles_to_place or {}
    local state = job.tile_cursor or {index = 1, foundation = true, placed = 0, failed = 0}
    job.tile_cursor = state
    local batch = {}
    local last = math.min(#tiles, state.index + budget - 1)
    -- Bound inspection as well as placement. Finish every foundation batch before
    -- starting overlays, including when the payload interleaves both kinds.
    for i = state.index, last do
        local tile = tiles[i]
        if (tile.name == "space-platform-foundation") == state.foundation then
            batch[#batch + 1] = tile
        end
    end
    if #batch > 0 then
        local placed, failed = Deserializer.place_tiles(job.target_surface, batch)
        state.placed, state.failed = state.placed + placed, state.failed + failed
        if failed > 0 then error("Tile placement failed; import stopped before entity creation") end
    end
    state.index = last + 1
    if state.index <= #tiles then return false end
    if state.foundation then
        state.foundation, state.index = false, 1
        return false
    end
    job.tiles_placed = true
    log(string.format("[FactorioSurfaceExport] Tile placement result: placed=%d, failed=%d", state.placed, state.failed))
    job.tile_cursor = nil
    return true
end

return TileRestoration
