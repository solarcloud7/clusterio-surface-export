return function(platform)
	if not (platform and platform.valid and platform.surface and platform.surface.valid) then return nil end
	local record = (storage.source_recovery_identities or {})[platform.index]
	if record and record.surface_index == platform.surface.index
		and platform.hub and platform.hub.valid and record.hub_unit_number == platform.hub.unit_number then return record.uid end
	local epoch = (storage.source_recovery_surface_epochs or {})[platform.surface.index]
	if epoch and platform.hub and platform.hub.valid and platform.hub.unit_number then
		return epoch .. ":" .. tostring(platform.hub.unit_number)
	end
	return nil
end
