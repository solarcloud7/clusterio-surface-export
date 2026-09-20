local root = "docker/seed-data/external_plugins/surface_export/module/"
local function fixture()
	local unlocked, hidden, visible = {nauvis = true}, {}, {}
	local planets = {}
	for index, name in ipairs({"nauvis", "fulgora", "gleba"}) do
		local surface = {valid = true, index = index, name = name}
		surface.find_non_colliding_position = function() return {1, 1} end
		surface.request_to_generate_chunks = function() end
		surface.force_generate_chunk_requests = function() end
		planets[name] = {name = name, surface = surface, prototype = {localised_name = name}}
		surface.planet = planets[name]
	end
	local force = {index = 1, technologies = {}}
	force.is_space_location_unlocked = function(name) return unlocked[name] == true end
	force.unlock_space_location = function(name) unlocked[name] = true end
	force.lock_space_location = function(name) unlocked[name] = false end
	force.get_surface_hidden = function(surface) return hidden[surface.name] == true end
	force.set_surface_hidden = function(surface, value) hidden[surface.name] = value end
	force.set_script_visible = function(id, value) visible[id.name] = value end
	force.get_script_visible = function(id) return visible[id.name] end
	force.set_spawn_position = function(_, surface) force.spawn = surface.name end
	local env = setmetatable({storage = {source_recovery_epoch = "boot"}, game = {planets = planets, forces = {force}, players = {}},
		defines = {controllers = {remote = 7, cutscene = 9}}, log = function() end}, {__index = _G})
	env.game.get_surface = function(index)
		for _, planet in pairs(planets) do if planet.surface.index == index then return planet.surface end end
	end
	local policy = assert(loadfile(root .. "core/planet-policy.lua", "t", env))()
	return env, policy, force, unlocked, hidden, visible
end
local function request(disabled, default)
	return {version = 1, epoch = "boot", disabledPlanets = disabled or {"nauvis", "gleba"}, defaultPlanet = default or "fulgora", instanceName = "One"}
end
local env, policy, force, unlocked, hidden = fixture()
assert(policy.apply(request()).success)
assert(not unlocked.nauvis and not unlocked.gleba and unlocked.fulgora)
assert(hidden.nauvis and hidden.gleba and not hidden.fulgora and force.spawn == "fulgora")
local checkpoint = env.storage.surface_export_planet_policy
for _, invalid in ipairs({request({"nauvis"}, "nauvis"), request({"missing"}), request({}, "missing"), {version = 2},
	{version = 1, epoch = "old", defaultPlanet = "nauvis", disabledPlanets = {}, instanceName = "One"}}) do
	assert(not pcall(policy.apply, invalid))
	assert(env.storage.surface_export_planet_policy == checkpoint)
end
unlocked.nauvis, unlocked.gleba, unlocked.fulgora = true, true, false
policy.enforce(force)
assert(not unlocked.nauvis and not unlocked.gleba and unlocked.fulgora)
force.technologies.discovery = {researched = true, prototype = {effects = {{type = "unlock-space-location", space_location = "gleba"}}}}
assert(policy.apply(request({}, "fulgora")).success)
assert(unlocked.nauvis and unlocked.gleba and not hidden.nauvis)
assert(policy.apply(request()).success)
local body = {valid = true, name = "character"}
local player = {valid = true, index = 1, name = "Player", character = body, physical_surface_index = 1, controller_type = 7, print = function() end}
player.exit_remote_view = function() player.controller_type = 1 end
player.teleport = function(_, surface) player.physical_surface_index = surface.index; return true end
assert(policy.rescue(player) and player.physical_surface_index == 2)
assert(player.character == body)
player.physical_surface_index = 1
env.game.planets.nauvis.surface.platform = {valid = true}
assert(policy.rescue(player) and player.physical_surface_index == 1)
env.game.planets.nauvis.surface.platform = nil
player.teleport = function() return false end
assert(not policy.rescue(player))
assert(not policy.ensure_player(player))
assert(env.storage.surface_export_pending_arrivals[1])
player.teleport = function(_, surface) player.physical_surface_index = surface.index; return true end
assert(policy.ensure_player(player) and not env.storage.surface_export_pending_arrivals[1])
assert(policy.apply(request({}, "fulgora")).success)
player.physical_surface_index = 1
assert(policy.ensure_player(player) and player.physical_surface_index == 1)
player.controller_type = 9
assert(not policy.ensure_player(player, true))
player.controller_type = 1
assert(policy.ensure_player(player) and player.physical_surface_index == 2)
assert(policy.apply(request({}, "nauvis")).success)
assert(not unlocked.fulgora, "former default bypassed ordinary research after changing default")
local env2, policy2, force2, _, _, visible2 = fixture()
force2.set_script_visible({name = "nauvis"}, false)
assert(policy2.apply(request()).success)
assert(policy2.apply(request({}, "fulgora")).success)
assert(visible2.nauvis == false, "re-enabling erased a pre-existing script visibility override")
print("PASS planet policy rejection, research reconciliation, re-enable and player relocation decisions")
