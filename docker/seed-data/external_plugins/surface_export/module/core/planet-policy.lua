local Policy = {}

function Policy.default_planet()
	return storage.surface_export_planet_policy and storage.surface_export_planet_policy.default_planet or "nauvis"
end

function Policy.is_disabled(name)
	local policy = storage.surface_export_planet_policy
	return policy ~= nil and policy.disabled[name] == true
end

function Policy.default_surface()
	local planet = game.planets[Policy.default_planet()]
	return planet and planet.surface
end

local function research_unlocks(force, name)
	for _, technology in pairs(force.technologies) do
		if technology.researched then
			for _, effect in pairs(technology.prototype.effects) do
				if effect.type == "unlock-space-location" and effect.space_location == name then return true end
			end
		end
	end
	return false
end

function Policy.enforce(force)
	local policy = storage.surface_export_planet_policy
	if not policy then return end
	policy.previous[force.index] = policy.previous[force.index] or {}
	local previous = policy.previous[force.index]
	local managed = {[policy.default_planet] = true}
	for name in pairs(policy.disabled) do managed[name] = true end
	for name in pairs(managed) do
		local planet = game.planets[name]
		if planet then
			if not previous[name] then
				previous[name] = {
					unlocked = force.is_space_location_unlocked(name),
					hidden = planet.surface and force.get_surface_hidden(planet.surface) or false,
					script_visible = force.get_script_visible({type = "space-location", name = name}),
				}
			end
			if policy.disabled[name] then
				force.lock_space_location(name)
				force.set_script_visible({type = "space-location", name = name}, false)
				if planet.surface then force.set_surface_hidden(planet.surface, true) end
			end
		end
	end
	for name, prior in pairs(previous) do
		if not managed[name] then
			local planet = game.planets[name]
			if planet then
				if prior.unlocked or research_unlocks(force, name) then force.unlock_space_location(name)
				else force.lock_space_location(name) end
				force.set_script_visible({type = "space-location", name = name}, prior.script_visible)
				if planet.surface then force.set_surface_hidden(planet.surface, prior.hidden) end
			end
			previous[name] = nil
		end
	end
	local default = game.planets[policy.default_planet]
	if not default then return end
	force.unlock_space_location(policy.default_planet)
	force.set_script_visible({type = "space-location", name = policy.default_planet}, true)
	if default.surface then force.set_surface_hidden(default.surface, false) end
end

function Policy.rescue(player, use_default)
	if not (storage.surface_export_planet_policy and player and player.valid) then return true end
	local surface = game.get_surface(player.physical_surface_index)
	if surface and surface.valid then
		if surface.platform or (surface.planet and surface.planet.name == Policy.default_planet()) then return true end
		if not use_default and (not surface.planet or not Policy.is_disabled(surface.planet.name)) then return true end
	end
	local destination = Policy.default_surface()
	if not (destination and destination.valid) then return false end
	local character = player.character
	local position = destination.find_non_colliding_position(character and character.name or "character", {0, 0}, 64, 0.5)
	if not position then return false end
	if player.controller_type == defines.controllers.cutscene then return false end
	if player.controller_type == defines.controllers.remote then player.exit_remote_view() end
	if player.controller_type == defines.controllers.remote then return false end
	if not player.teleport(position, destination) then return false end
	local label = destination.planet and destination.planet.prototype.localised_name or destination.name
	player.print({"", use_default and "Welcome to " or "This planet is unavailable on this instance. Returned to ", label, "."})
	return true
end

function Policy.ensure_player(player, use_default)
	storage.surface_export_pending_arrivals = storage.surface_export_pending_arrivals or {}
	local pending = storage.surface_export_pending_arrivals
	use_default = use_default or (pending[player.index] and pending[player.index].use_default)
	if (storage.surface_export_planet_policy or not use_default) and Policy.rescue(player, use_default) then
		pending[player.index] = nil
		return true
	end
	if not pending[player.index] then log("[Surface Export] Player relocation pending for " .. player.name) end
	pending[player.index] = {use_default = use_default == true}
	return false
end

function Policy.apply(request)
	assert(type(request) == "table" and request.version == 1, "Unsupported planet policy protocol")
	assert(type(request.epoch) == "string" and request.epoch == storage.source_recovery_epoch, "Planet policy belongs to a different instance startup")
	assert(type(request.defaultPlanet) == "string" and game.planets[request.defaultPlanet], "Default planet is not installed")
	assert(type(request.disabledPlanets) == "table", "Disabled planets must be an array")
	assert(type(request.instanceName) == "string", "Missing instance name")
	local disabled = {}
	for key, name in pairs(request.disabledPlanets) do
		assert(type(key) == "number" and key >= 1 and key % 1 == 0 and type(name) == "string" and game.planets[name], "Disabled planet is not installed")
		disabled[name] = true
	end
	assert(not disabled[request.defaultPlanet], "The default planet must be enabled")
	local planet = game.planets[request.defaultPlanet]
	local surface = planet.surface or planet.create_surface()
	surface.request_to_generate_chunks({0, 0}, 2)
	surface.force_generate_chunk_requests()
	assert(surface.find_non_colliding_position("character", {0, 0}, 64, 0.5), "Default planet has no safe arrival position near 0,0")
	local old = storage.surface_export_planet_policy
	storage.surface_export_planet_policy = {
		default_planet = request.defaultPlanet, disabled = disabled, instance_name = request.instanceName,
		previous = old and old.previous or {},
	}
	for _, force in pairs(game.forces) do
		Policy.enforce(force)
		force.set_spawn_position({0, 0}, surface)
	end
	for _, player in pairs(game.players) do
		Policy.ensure_player(player)
	end
	return {success = true, version = 1, defaultPlanet = request.defaultPlanet, disabledPlanets = request.disabledPlanets, instanceName = request.instanceName, epoch = request.epoch}
end

return Policy
