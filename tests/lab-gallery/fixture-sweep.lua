return function(platforms, matches, unlock)
    local result = {success=true, swept=0, errors={}}
    for _, platform in pairs(platforms) do
        if platform.valid and matches(platform) then
            local ok, err = pcall(function()
                assert(unlock(platform), "Fixture unlock refused")
                assert(platform.surface and platform.surface.valid, "Fixture surface unavailable")
                assert(game.delete_surface(platform.surface), "Fixture deletion refused")
                result.swept = result.swept + 1
            end)
            if not ok then
                result.success = false
                result.errors[#result.errors+1] = {index=platform.index,error=tostring(err)}
            end
        end
    end
    return result
end
