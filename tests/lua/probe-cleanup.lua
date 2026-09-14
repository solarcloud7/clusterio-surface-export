local query = io.read("*a")
local run = assert(load(query))
local deletes, platform, record
local function reset()
    deletes = 0
    record = {platform_index=33, platform_uid="destination-clone"}
    platform = {index=33, valid=true, surface={index=133, valid=true}, force={name="player"}}
    storage = {locked_platforms={}, destination_holds={}, async_jobs={}}
    game = {forces={player={platforms={[33]=platform}}}, delete_surface=function(surface)
        assert(surface == platform.surface)
        deletes = deletes + 1
        platform.valid = false
        return true
    end}
    remote = {call=function(_, action)
        if action == "unlock_platform" then return true end
        assert(action == "list_platforms", "unexpected remote call")
        return {record}
    end}
end

local cases = {
    function() record.platform_uid="replacement" end,
    function() platform.surface.index=134 end,
    function() platform.valid=false end,
    function() storage.locked_platforms[33]={transfer_job_id="another-job",force_name="player",platform_index=33,surface_index=133} end,
    function() storage.destination_holds.other={platform_index=33,surface_index=500} end,
    function() storage.destination_holds.other={platform_index=500,surface_index=133} end,
    function() storage.async_jobs.other={platform_index=33} end,
    function() storage.async_jobs.other={target_platform=platform} end,
    function() storage.async_jobs.other={target_surface=platform.surface} end,
}
for i, setup in ipairs(cases) do
    reset()
    setup()
    local ok, result = pcall(run)
    assert(not ok or result.success == false, "unsafe cleanup accepted case " .. i)
    assert(deletes == 0, "unsafe cleanup deleted case " .. i)
end

reset()
local result = run()
assert(result.success and result.swept == 1 and deletes == 1)
reset()
game.delete_surface=function() return false end
result = run()
assert(result.success == false and result.swept == 0 and #result.errors == 1)
print("probe cleanup Lua guards PASS")
