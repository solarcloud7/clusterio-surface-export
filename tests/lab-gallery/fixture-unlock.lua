return function(platform)
    assert(platform and platform.valid and platform.surface and platform.surface.valid, "Fixture platform unavailable")
    local lock = storage.locked_platforms and storage.locked_platforms[platform.index]
    if not lock then return true end
    assert(lock.force_name == platform.force.name and lock.platform_index == platform.index
        and lock.surface_index == platform.surface.index, "Fixture lock location mismatch")
    assert(type(lock.transfer_job_id) == "string" and lock.transfer_job_id ~= "", "Fixture lock job unavailable")
    local ok, err = remote.call("surface_export", "unlock_platform", platform.index, nil, lock.transfer_job_id)
    assert(ok == true, "Fixture unlock refused: " .. tostring(err))
    return true
end
