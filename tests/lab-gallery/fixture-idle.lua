return function(p)
    assert(p and p.valid and p.surface and p.surface.valid, 'Fixture platform unavailable')
    assert(not (storage.locked_platforms or {})[p.index],'Probe platform is locked; preserve it')
    for _,hold in pairs(storage.destination_holds or {}) do
        assert(hold.platform_index~=p.index and hold.surface_index~=p.surface.index,'Probe platform has a destination hold')
    end
    for _,job in pairs(storage.async_jobs or {}) do
        assert(job.platform_index~=p.index and job.target_platform~=p and job.target_surface~=p.surface,'Probe platform has active work')
    end
    return true
end
