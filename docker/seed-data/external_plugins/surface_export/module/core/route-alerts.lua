local RouteAlerts = {}

local function records()
	storage.surface_export_route_alerts = storage.surface_export_route_alerts or {}
	return storage.surface_export_route_alerts
end

local function key(platform)
	return platform.force.name .. ":" .. platform.index
end

local function resolve(record)
	local force = game.forces[record.force_name]
	local platform = force and force.platforms[record.platform_index]
	if platform and platform.valid and platform.name == record.platform_name then return platform end
	return nil
end

local function still_applies(record, platform)
	if record.kind == "no_path" then return platform.state == defines.space_platform_state.no_path end
	return platform.paused == true
end

local function show(record, platform, player)
	local hub = platform.hub
	if not (hub and hub.valid) then return end
	player.remove_alert{entity = hub, type = defines.alert_type.custom}
	player.add_custom_alert(hub, {type = "space-location", name = record.icon}, record.message, true)
end

function RouteAlerts.raise(platform, kind, icon, reason)
	local record = {force_name = platform.force.name, platform_index = platform.index, platform_name = platform.name,
		kind = kind, icon = icon, message = {"", platform.name, ": ", reason}}
	records()[key(platform)] = record
	log(string.format("[Gateway] Route alert for '%s' (%s): %s", platform.name, kind, serpent.line(reason)))
	for _, player in pairs(platform.force.connected_players) do show(record, platform, player) end
end

function RouteAlerts.clear(platform)
	local k = key(platform)
	if not records()[k] then return end
	records()[k] = nil
	local hub = platform.hub
	if not (hub and hub.valid) then return end
	for _, player in pairs(platform.force.connected_players) do
		player.remove_alert{entity = hub, type = defines.alert_type.custom}
	end
end

function RouteAlerts.refresh()
	local all = records()
	for k, record in pairs(all) do
		local platform = resolve(record)
		if not platform then
			all[k] = nil
		elseif not still_applies(record, platform) then
			RouteAlerts.clear(platform)
		else
			for _, player in pairs(platform.force.connected_players) do show(record, platform, player) end
		end
	end
end

return RouteAlerts
