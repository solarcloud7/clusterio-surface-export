local Deserializer = require("modules/surface_export/core/deserializer")
local TileRestoration = {}

function TileRestoration.process(job, budget)
    if job.tiles_placed then
        return true
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
