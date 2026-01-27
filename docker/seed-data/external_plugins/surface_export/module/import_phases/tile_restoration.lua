local Deserializer = require("modules/surface_export/core/deserializer")
local TileRestoration = {}

--- Process tile placement for an import job
--- @param job table: The import job state
--- @return boolean: true if tiles were processed (or didn't need processing)
function TileRestoration.process(job)
    -- Place all tiles first (before any entities)
    if job.tiles_placed then
        return true
    end

    if job.tiles_to_place and #job.tiles_to_place > 0 then
        log(string.format("[FactorioSurfaceExport] Placing %d tiles for platform %s", #job.tiles_to_place, job.platform_name))
        local placed, failed = Deserializer.place_tiles(job.target_surface, job.tiles_to_place)
        log(string.format("[FactorioSurfaceExport] Tile placement result: placed=%d, failed=%d", placed, failed))
        if placed > 0 then
          game.print(string.format("[Import %s] Placed %d tiles", job.platform_name, placed))
        end
        if failed > 0 then
          game.print(string.format("[Import %s] Warning: Failed to place %d tiles", job.platform_name, failed), {1, 0.5, 0})
        end
        job.tiles_placed = true
    else
        local tile_count = job.tiles_to_place and #job.tiles_to_place or 0
        log(string.format("[FactorioSurfaceExport] No tiles to place for %s (count=%d)", job.platform_name, tile_count))
        job.tiles_placed = true
    end

    return true
end

return TileRestoration