local RouteAlerts = {}

RouteAlerts.sender = nil
RouteAlerts.REMOTE_EXPIRY_TICKS = 3600
RouteAlerts.GPS_SURFACE_PREFIX = "surfexp_route_"

local function records()
	storage.surface_export_route_alerts = storage.surface_export_route_alerts or {}
	return storage.surface_export_route_alerts
end

local function remote_records()
	storage.surface_export_remote_route_alerts = storage.surface_export_remote_route_alerts or {}
	return storage.surface_export_remote_route_alerts
end

local function key(platform)
	return platform.force.name .. ":" .. platform.index
end

local function send(record, active)
	if not RouteAlerts.sender then return end
	local ok, err = pcall(RouteAlerts.sender, {key = record.key, platform_name = record.platform_name,
		force_name = record.force_name, icon = record.icon, active = active, reason = record.reason})
	if not ok then log("[Gateway] Route alert relay failed: " .. tostring(err)) end
end

local function resolve(record)
	local force = game.forces[record.force_name]
	local platform = force and force.platforms[record.platform_index]
	if platform and platform.valid and platform.name == record.platform_name and (platform.scheduled_for_deletion or 0) == 0 then
		return platform
	end
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

local function show_remote(record, player)
	local character = player.character
	if not (character and character.valid) then return end
	player.remove_alert{type = defines.alert_type.custom, message = record.message}
	player.add_custom_alert(character, {type = "space-location", name = record.icon}, record.message, false)
end

local function force_players(force_name)
	local force = game.forces[force_name]
	return force and force.connected_players or {}
end

function RouteAlerts.raise(platform, kind, icon, reason)
	local record = {key = key(platform), force_name = platform.force.name, platform_index = platform.index,
		platform_name = platform.name, kind = kind, icon = icon, reason = reason, message = {"", platform.name, ": ", reason}}
	records()[record.key] = record
	log(string.format("[Gateway] Route alert for '%s' (%s): %s", platform.name, kind, serpent.line(reason)))
	for _, player in pairs(platform.force.connected_players) do show(record, platform, player) end
	send(record, true)
end

function RouteAlerts.clear(platform)
	local k = key(platform)
	local record = records()[k]
	if not record then return end
	records()[k] = nil
	send(record, false)
	local hub = platform.hub
	if not (hub and hub.valid) then return end
	for _, player in pairs(platform.force.connected_players) do
		player.remove_alert{entity = hub, type = defines.alert_type.custom}
	end
end

function RouteAlerts.receive(alert)
	local id = tostring(alert.sourceInstanceId) .. ":" .. tostring(alert.key)
	local all = remote_records()
	local existing = all[id]
	if not alert.active then
		all[id] = nil
		if existing then
			for _, player in pairs(force_players(existing.force_name)) do
				player.remove_alert{type = defines.alert_type.custom, message = existing.message}
			end
		end
		return
	end
	local icon = prototypes.space_location[alert.icon] and alert.icon or "surfexp_gateway_hub"
	local destination = prototypes.space_location["surfexp_gateway_i_" .. tostring(alert.sourceInstanceId)]
	local server = destination and destination.localised_name or alert.sourceName
	local record = {force_name = alert.forceName or "player", icon = icon, source_id = alert.sourceInstanceId,
		source_name = alert.sourceName, seen_tick = game.tick,
		message = {"", alert.platformName, " on ", server, ": ", alert.reason or ""}}
	all[id] = record
	for _, player in pairs(force_players(record.force_name)) do show_remote(record, player) end
	if not existing and game.forces[record.force_name] then
		game.forces[record.force_name].print({"", "[img=space-location/", icon, "] ", record.message,
			" [gps=0,0,", RouteAlerts.GPS_SURFACE_PREFIX, tostring(record.source_id), "]"})
	end
end

function RouteAlerts.server_from_gps(surface_name)
	local id = type(surface_name) == "string" and surface_name:match("^" .. RouteAlerts.GPS_SURFACE_PREFIX .. "(%d+)$")
	return id and tonumber(id) or nil
end

function RouteAlerts.refresh()
	local all = records()
	for k, record in pairs(all) do
		local platform = resolve(record)
		if not platform then
			all[k] = nil
			send(record, false)
		elseif not still_applies(record, platform) then
			RouteAlerts.clear(platform)
		else
			for _, player in pairs(platform.force.connected_players) do show(record, platform, player) end
			send(record, true)
		end
	end
	local remote = remote_records()
	for id, record in pairs(remote) do
		if game.tick - (record.seen_tick or 0) > RouteAlerts.REMOTE_EXPIRY_TICKS then
			remote[id] = nil
			for _, player in pairs(force_players(record.force_name)) do
				player.remove_alert{type = defines.alert_type.custom, message = record.message}
			end
		else
			for _, player in pairs(force_players(record.force_name)) do show_remote(record, player) end
		end
	end
end

return RouteAlerts
