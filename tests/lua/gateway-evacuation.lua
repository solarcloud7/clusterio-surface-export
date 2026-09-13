local root = "docker/seed-data/external_plugins/surface_export/module/"
local function fixture(options)
    options = options or {}
    local bodies, players = {}, {}
    local source = {valid = true, index = 9}
    local destination = {valid = true, index = 1, name = "nauvis", find_non_colliding_position = function() return {0, 0} end}
    local platform = {valid = true, name = "fixture", surface = source,
        force = {valid = true, get_spawn_position = function() return {0, 0} end}}
    local function aboard()
        local result = {}
        for _, body in ipairs(bodies) do if body.surface == source then result[#result + 1] = body end end
        return result
    end
    source.count_entities_filtered = function()
        if options.count_error then error("injected count failure") end
        return #aboard()
    end
    source.find_entities_filtered = function()
        if options.find_error then error("injected find failure") end
        return aboard()
    end
    local function teleport(object, dest)
        if options.throw then error("injected teleport failure") end
        if options.refuse then return false end
        if not options.false_success then object.surface = dest end
        return true
    end
    if not options.empty then
        local body = {valid = true, name = "character", surface = source}
        body.teleport = function(_, dest) return teleport(body, dest) end
        bodies[1] = body
    end
    if options.player then
        local player = {valid = true, name = "passenger", character = bodies[1], print = function() end}
        setmetatable(player, {__index = function(_, key)
            if key == "physical_surface_index" then
                if options.player_error then error("injected player read failure") end
                return bodies[1].surface.index
            end
        end})
        player.teleport = function(_, dest) return teleport(bodies[1], dest) end
        players[1] = player
    end
    local env = setmetatable({game = {players = players, surfaces = options.no_destination and {} or {nauvis = destination}},
        log = function() end}, {__index = _G})
    return assert(loadfile(root .. "core/gateway.lua", "t", env))(), platform, bodies, source
end
for _, options in ipairs({{refuse = true}, {throw = true}, {false_success = true}, {no_destination = true},
    {count_error = true}, {find_error = true}, {player = true, player_error = true}, {player = true, refuse = true}}) do
    local gateway, platform, bodies, source = fixture(options)
    local result = gateway.evacuate_passengers(platform)
    assert(result.success == false, "failed or unverified evacuation was accepted")
    assert(bodies[1].surface == source, "fixture did not retain its body")
end
for _, options in ipairs({{}, {player = true}, {empty = true, no_destination = true}}) do
    local gateway, platform, bodies, source = fixture(options)
    local result = gateway.evacuate_passengers(platform)
    assert(result.success == true and result.failures == 0, "safe evacuation refused")
    for _, body in ipairs(bodies) do assert(body.surface ~= source, "reported success with a body aboard") end
end
print("PASS evacuation requires verified empty source, including false/throwing teleports and failed reads")
