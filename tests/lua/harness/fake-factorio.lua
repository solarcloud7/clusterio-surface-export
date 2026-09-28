local root = os.getenv("SE_MODULE_ROOT") or "docker/seed-data/external_plugins/surface_export/module/"
local json = assert(loadfile(root .. "core/json.lua"))()
local unpack = table.unpack or unpack
local noop = function() end
local output = {}

local function deepcopy(value, memo)
	if type(value) ~= "table" then return value end
	memo = memo or {}
	if memo[value] then return memo[value] end
	local copy = {}
	memo[value] = copy
	for key, item in pairs(value) do copy[deepcopy(key, memo)] = deepcopy(item, memo) end
	return setmetatable(copy, getmetatable(value))
end

defines = {
	controllers = {character = 1, remote = 2, cutscene = 3, god = 4, spectator = 5},
	space_platform_state = {on_the_path = 1, waiting_at_station = 2, waiting_for_departure = 3, no_path = 4, no_schedule = 5, paused = 6},
	inventory = {cargo_unit = 1, hub_main = 2},
}
helpers = {
	json_to_table = function(text) local ok, value = pcall(json.decode, text); if ok then return value end end,
	table_to_json = function(value) return json.encode(value) end,
}
script = {active_mods = {base = "2.1.20"}}
log = function(message) if os.getenv("SE_HARNESS_LOG") then io.stderr:write(tostring(message), "\n") end end
rcon = {print = function(value) output[#output + 1] = tostring(value) end}
storage = {}

local world
local function surface_methods(surface_index)
	local function surface() return world.surfaces[surface_index] end
	return {
		find_entities_filtered = function(filter)
			local s = surface()
			if filter and filter.name == "space-platform-hub" and s.platform and s.platform.hub then return {s.platform.hub} end
			return {}
		end,
		count_entities_filtered = function(filter)
			local count = 0
			if filter and filter.type == "character" then
				for _, player in pairs(world.players) do
					if player.physical_surface_index == surface_index and player.character then count = count + 1 end
				end
			end
			return count
		end,
		find_non_colliding_position = function() return {x = 0, y = 0} end,
	}
end

local function new_surface(name, platform)
	world.next_surface = world.next_surface + 1
	local surface = {valid = true, index = world.next_surface, name = name, platform = platform}
	for key, fn in pairs(surface_methods(surface.index)) do surface[key] = fn end
	world.surfaces[surface.index] = surface
	return surface
end

local function new_force(name)
	local hidden = {}
	return {name = name, valid = true, platforms = {}, technologies = {},
		get_surface_hidden = function(surface) return hidden[surface.index] == true end,
		set_surface_hidden = function(surface, value) hidden[surface.index] = value == true end,
		get_spawn_position = function() return {x = 0, y = 0} end}
end

local function reset_world()
	world = {forces = {}, surfaces = {}, players = {}, planets = {}, next_surface = 0, next_platform = 0, next_unit = 100, tick = 1}
	world.forces.player = new_force("player")
	world.planets.nauvis = {name = "nauvis", surface = new_surface("nauvis")}
end
reset_world()

game = setmetatable({}, {__index = function(_, key)
	if key == "forces" then return world.forces end
	if key == "surfaces" then return world.surfaces end
	if key == "players" then return world.players end
	if key == "connected_players" then return {} end
	if key == "planets" then return world.planets end
	if key == "tick" then return world.tick end
	if key == "delete_surface" then
		return function(surface)
			if not (surface and surface.valid) then return false end
			surface.valid = false
			local platform = surface.platform
			if platform then
				platform.valid = false
				platform.force.platforms[platform.index] = nil
			end
			return true
		end
	end
	if key == "print" then return noop end
	if key == "get_player" then return function(index) return world.players[index] end end
end, __newindex = function(_, key, value) if key == "tick" then world.tick = value end end})

local stubs = {
	["modules/clusterio/api"] = {send_json = noop, events = {}},
	["modules/surface_export/utils/operation-timing"] = setmetatable({scope = function(_, _, fn, ...) return fn(...) end},
		{__index = function() return noop end}),
	["modules/surface_export/utils/platform-schedule"] = {capture = function() return {} end, apply = function() return true end,
		summarize = function() return {record_count = 0, interrupt_count = 0} end},
	["modules/surface_export/import_phases/latch_rearm"] = {pending_on_surface = function() return false end},
	["modules/surface_export/core/passenger-transit"] = {depart = function() return {} end, settle = noop, notify_departed = noop,
		transfer_released = noop, manifest = function() return {} end},
	["modules/surface_export/core/passenger-arrival"] = {take_staged = function() return nil, nil end, process_connected = noop},
	["modules/surface_export/core/route-alerts"] = {raise = noop, clear = noop},
}
local harness = {exports = {}, fail_next_export = false}
local loaded = {}
require = function(name)
	if loaded[name] then return loaded[name] end
	if stubs[name] then loaded[name] = stubs[name]; return stubs[name] end
	local short = assert(name:match("^modules/surface_export/(.*)$"), "unexpected module " .. name)
	if short == "core/async-processor" then loaded[name] = harness.async; return harness.async end
	local chunk = assert(loadfile(root .. short .. ".lua", "t", _G))
	loaded[name] = chunk()
	return loaded[name]
end

local SurfaceLock = require("modules/surface_export/utils/surface-lock")
local PlatformLineage = require("modules/surface_export/utils/platform-lineage")
local Recovery

harness.async = {queue_export = function(platform_index, force_name, requester, destination, _, _, operation_id, expected_uid, _, purpose)
	storage.async_job_id_counter = (storage.async_job_id_counter or 0) + 1
	local force = game.forces[force_name]
	local platform = force and force.platforms[platform_index]
	if not (platform and platform.valid) then return nil, "Platform not found" end
	local uid = Recovery.platform_uid(platform)
	if not uid or (expected_uid and expected_uid ~= uid) then return nil, "Source platform identity changed or is unavailable" end
	local job_id = Recovery.export_job_id(storage.async_job_id_counter, platform.name:gsub("[^%w%-]", "-"))
	local lineage, generation, lineage_err
	if purpose == "resolution" then lineage, generation = PlatformLineage.get(platform)
	else lineage, generation, lineage_err = PlatformLineage.for_export(platform, destination and true or false) end
	if lineage_err then return nil, lineage_err end
	local ok, lock_err = SurfaceLock.lock_platform(platform, force, {kind = (destination or purpose == "resolution") and "transfer" or "export", job_id = job_id})
	if not ok and lock_err ~= "Platform already locked" then return nil, "Failed to lock platform: " .. tostring(lock_err) end
	storage.async_job_results = storage.async_job_results or {}
	if harness.fail_next_export then
		harness.fail_next_export = false
		storage.async_job_results[job_id] = {status = "failed", complete = true, type = "export", job_id = job_id, error = "injected export failure"}
		SurfaceLock.unlock_platform(platform_index, nil, nil, nil, job_id)
		return job_id
	end
	storage.async_job_results[job_id] = {status = "complete", complete = true, type = "export", job_id = job_id}
	harness.exports[#harness.exports + 1] = {jobId = job_id, platformIndex = platform_index, platformName = platform.name,
		purpose = purpose, exportData = {platform_uid = uid, platform_name = platform.name, force_name = force_name,
			lineage = lineage, generation = generation, purpose = purpose, platform = {force = force_name, schedule = {}},
			verification = {item_counts = {}, fluid_counts = {}}}}
	if not destination and purpose ~= "resolution" then SurfaceLock.unlock_platform(platform_index, nil, nil, nil, job_id) end
	return job_id
end}

Recovery = require("modules/surface_export/core/source-recovery")
local DestinationHold = require("modules/surface_export/core/destination-hold")
local Resolution = require("modules/surface_export/interfaces/remote/resolution")
local JobStatus = require("modules/surface_export/core/job-status")

local function json_wrap(fn)
	return function(...)
		local result = fn(...)
		if result ~= nil then return json.encode(result) end
		return "null"
	end
end

local interface = {
	source_recovery_begin = json_wrap(Recovery.begin),
	source_recovery_reconcile = json_wrap(Recovery.reconcile),
	source_recovery_finish = json_wrap(Recovery.finish),
	source_recovery_identity = json_wrap(Recovery.source_identity),
	source_recovery_presence = json_wrap(Recovery.lineage_presence),
	resolution_candidates_json = json_wrap(Resolution.candidates),
	resolution_apply_json = json_wrap(Resolution.apply),
	delete_platform_for_transfer = require("modules/surface_export/interfaces/remote/delete-platform-for-transfer"),
	destination_hold_json = json_wrap(require("modules/surface_export/interfaces/remote/destination-hold")),
	unlock_platform = require("modules/surface_export/interfaces/remote/unlock-platform"),
	get_source_transfer_lock_state_json = json_wrap(require("modules/surface_export/interfaces/remote/get-source-transfer-lock-state")),
	passenger_manifest = function() return json.encode({success = true, passengers = {}}) end,
	get_job_status_json = function(text)
		local request = json.decode(text)
		local jobs = {}
		for index, ref in ipairs(request.jobs or {}) do jobs[index] = JobStatus.read(ref.jobId) end
		return json.encode({version = 1, epoch = storage.source_recovery_epoch, observedTick = game.tick, jobs = jobs})
	end,
}
remote = {call = function(_, name, ...) return assert(interface[name], "unknown remote " .. tostring(name))(...) end}

function harness.create_platform(name, force_name, with_hub)
	local force = game.forces[force_name or "player"]
	if not force then
		force = new_force(force_name)
		world.forces[force_name] = force
	end
	world.next_platform = world.next_platform + 1
	local platform = {valid = true, index = world.next_platform, name = name, force = force, hidden = false, paused = false,
		state = defines.space_platform_state.waiting_at_station}
	platform.surface = new_surface("platform-" .. platform.index, platform)
	force.platforms[platform.index] = platform
	Recovery.surface_created(platform.surface.index)
	if with_hub ~= false then harness.add_hub(platform.index, force.name) end
	return platform.index
end

function harness.add_hub(index, force_name)
	local platform = game.forces[force_name or "player"].platforms[index]
	world.next_unit = world.next_unit + 1
	platform.hub = {valid = true, unit_number = world.next_unit, name = "space-platform-hub"}
	return world.next_unit
end

function harness.add_player(name, index, force_name)
	local platform = game.forces[force_name or "player"].platforms[index]
	local player = {name = name, index = #world.players + 1, valid = true, connected = false,
		physical_surface_index = platform.surface.index, controller_type = defines.controllers.character,
		character = {valid = true, name = "character"}}
	player.teleport = function(_, surface)
		local current = world.players[player.index]
		current.physical_surface_index = surface.index
		return true
	end
	player.leave_space_platform = noop
	player.exit_remote_view = noop
	world.players[player.index] = player
	return player.index
end

function harness.player_surface(index) return world.players[index].physical_surface_index end

function harness.platform(index, force_name)
	local platform = (game.forces[force_name or "player"] or {platforms = {}}).platforms[index]
	if not (platform and platform.valid) then return {present = false} end
	local lock = SurfaceLock.get_lock_data(index)
	local lineage, generation = PlatformLineage.get(platform)
	return {present = true, name = platform.name, hidden = platform.hidden, uid = Recovery.platform_uid(platform),
		lockKind = lock and lock.kind or nil, phase = lock and lock.phase or nil, reason = lock and lock.quarantine and lock.quarantine.reason or nil,
		lineage = lineage, generation = generation, usable = not lock and platform.hidden ~= true}
end

function harness.find(name, force_name)
	for index, platform in pairs(game.forces[force_name or "player"].platforms) do
		if platform.valid and platform.name == name then return index end
	end
end

function harness.take_exports()
	local list = harness.exports
	harness.exports = {}
	return list
end

function harness.import(data, name, force_name)
	local force = game.forces[force_name or "player"]
	local index = harness.create_platform(name, force.name)
	local platform = force.platforms[index]
	local lineage, generation, err = PlatformLineage.transfer_carry(data)
	if err then return {success = false, error = err} end
	local job_id = "import_" .. index
	local carried = PlatformLineage.hold_carry({lineage = lineage, lineage_generation = generation, transfer_id = data._transferId, platform_data = data})
	local ok, hold = DestinationHold.stage(data._transferId, platform, force, true, nil, job_id, carried)
	if not ok then return {success = false, error = hold} end
	return {success = true, jobId = job_id, platformIndex = index}
end

function harness.lineage_copy(name, lineage, generation, force_name)
	local index = harness.create_platform(name, force_name)
	local platform = game.forces[force_name or "player"].platforms[index]
	assert(PlatformLineage.record(platform, lineage, generation))
	return index
end

function harness.quarantine_copy(name, lineage, generation, reason, force_name)
	local index = harness.lineage_copy(name, lineage, generation, force_name)
	local platform = game.forces[force_name or "player"].platforms[index]
	assert(SurfaceLock.lock_platform(platform, platform.force, {kind = "startup"}))
	local lock = SurfaceLock.get_lock_data(index)
	lock.kind = "quarantine"
	lock.platform_uid = Recovery.platform_uid(platform)
	lock.quarantine = {reason = reason or "duplicate", lineage = lineage, generation = generation, epoch = storage.source_recovery_epoch}
	storage.source_recovery_notices = storage.source_recovery_notices or {}
	storage.source_recovery_notices[index] = {platformIndex = index, platformName = name, platformUid = lock.platform_uid,
		status = "quarantined", reason = reason or "duplicate", lineage = lineage, generation = generation}
	return index
end

function harness.block_teleport(index)
	world.players[index].teleport = function() return false end
	return true
end

function harness.startup() Recovery.startup() return true end

function harness.save(name)
	harness.saves = harness.saves or {}
	harness.saves[name] = deepcopy({storage = storage, world = world})
	return true
end

function harness.load(name)
	local snapshot = deepcopy(harness.saves[name])
	storage = snapshot.storage
	world = snapshot.world
	Recovery.startup()
	return true
end

function harness.set(path, value)
	local target = storage
	for part in path:gmatch("[^.]+") do
		if part == path:match("[^.]+$") then target[part] = value else target[part] = target[part] or {}; target = target[part] end
	end
	return true
end

harness.SurfaceLock = SurfaceLock
harness.Recovery = Recovery
_G.harness = harness

while true do
	local line = io.read("*l")
	if not line then break end
	local request = json.decode(line)
	output = {}
	world.tick = world.tick + 1
	local source = request.command:gsub("^/sc ", "")
	local chunk, compile_err = load(source, "=rcon", "t", _G)
	local ok, err = false, compile_err
	if chunk then ok, err = pcall(chunk) end
	io.write(json.encode({output = table.concat(output, "\n"), error = not ok and tostring(err) or nil}), "\n")
	io.flush()
end
