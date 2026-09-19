local identity = require("modules/surface_export/utils/platform-identity")
local SurfaceLock = require("modules/surface_export/utils/surface-lock")
local Boarding = {}

function Boarding.enabled()
	local setting = settings.global["surfexp-platform-boarding"]
	return setting ~= nil and setting.value == true
end

function Boarding.source(player)
	local surface = game.get_surface(player.physical_surface_index)
	return surface and surface.valid and surface.platform
end

function Boarding.available(platform)
	return platform and platform.valid and platform.surface and platform.surface.valid
		and platform.hub and platform.hub.valid and not platform.paused and not platform.hidden
		and platform.space_location ~= nil and platform.space_connection == nil
		and not SurfaceLock.is_locked(platform.index)
		and not SurfaceLock.destination_hold_owns_surface(platform.surface, platform)
		and identity(platform) ~= nil
end

function Boarding.targets(player)
	local source = Boarding.source(player)
	local targets = {}
	if storage.source_recovery_ready ~= true or not Boarding.enabled() or not Boarding.available(source) then return targets end
	for _, target in pairs(player.force.platforms) do
		if target ~= source and Boarding.available(target) and target.space_location.name == source.space_location.name then
			targets[#targets + 1] = {
				name = target.name, force = target.force.name, index = target.index,
				uid = identity(target), source_uid = identity(source),
			}
		end
	end
	table.sort(targets, function(a, b)
		if a.name == b.name then return a.index < b.index end
		return a.name < b.name
	end)
	return targets
end

function Boarding.board(player, selection)
	if storage.source_recovery_ready ~= true then return false, "Instance recovery is not ready." end
	if not Boarding.enabled() then return false, "Platform boarding is disabled in map settings." end
	local source = Boarding.source(player)
	local force = selection and game.forces[selection.force]
	local target = force and force.platforms[selection.index]
	if not Boarding.available(source) or not Boarding.available(target) then
		return false, "Both platforms must be enabled and free of transfer or recovery locks."
	end
	if force ~= player.force or source.force ~= player.force or source == target
		or identity(source) ~= selection.source_uid or identity(target) ~= selection.uid then
		return false, "The selected platform is no longer available. Refresh the list."
	end
	if source.space_location.name ~= target.space_location.name then return false, "The platforms are no longer at the same location." end
	if player.hub then player.leave_space_platform() end
	if not player.enter_space_platform(target) then return false, "Factorio could not board that platform." end
	return true
end

return Boarding
