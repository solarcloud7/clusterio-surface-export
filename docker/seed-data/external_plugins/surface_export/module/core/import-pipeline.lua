local Deserializer = require("modules/surface_export/core/deserializer")
local Util = require("modules/surface_export/utils/util")
local PlatformSchedule = require("modules/surface_export/utils/platform-schedule")
local TileRestoration = require("modules/surface_export/import_phases/tile_restoration")
local PlatformHubMapping = require("modules/surface_export/import_phases/platform_hub_mapping")
local EntityCreation = require("modules/surface_export/import_phases/entity_creation")
local PhaseProfiler = require("modules/surface_export/utils/phase-profiler")
local PhaseRecorder = require("modules/surface_export/utils/phase-recorder")
local GameUtils = require("modules/surface_export/utils/game-utils")
local VersionCompat = require("modules/surface_export/utils/version-compat")
local Gateway = require("modules/surface_export/core/gateway")

local ImportPipeline = {}

function ImportPipeline.queue_from_file(filename, new_platform_name, force_name, requester_name)
	local filepath = "platform_exports/" .. filename
	local json_data, err = Util.read_file_compat(filepath)

	if not json_data then
		return nil, "Failed to read file '" .. filename .. "': " .. (err or "unknown error")
	end

	return ImportPipeline.queue(json_data, new_platform_name, force_name, requester_name)
end

function ImportPipeline.queue(json_data, new_platform_name, force_name, requester_name, receive_timing)
	storage.async_job_id_counter = storage.async_job_id_counter + 1
	local job_id = "import_" .. storage.async_job_id_counter

	log(string.format("[Import Queue] job_id=%s, platform='%s', force=%s, requester=%s, data_type=%s",
		job_id, tostring(new_platform_name), tostring(force_name), tostring(requester_name), type(json_data)))
	if type(json_data) == "string" then
		log(string.format("[Import Queue] JSON string size: %d bytes", #json_data))
	end

	PhaseProfiler.init(job_id, PhaseRecorder.profiler_names())
	PhaseProfiler.start(job_id, "queue_setup")

	local parsed_data
	if type(json_data) == "string" then
		parsed_data = Util.json_to_table_compat(json_data)
		if not parsed_data then
			return nil, "Failed to parse JSON data"
		end
	else
		parsed_data = json_data
	end

	local platform_data
	if parsed_data.compressed and parsed_data.payload then
		log(string.format("[Decompression] Decompressing import data (%d bytes compressed)", #parsed_data.payload))
		local decompressed_json = helpers.decode_string(parsed_data.payload)
		if not decompressed_json then
			return nil, "Failed to decompress data"
		end
		log(string.format("[Decompression] Decompressed to %d bytes", #decompressed_json))

		platform_data = Util.json_to_table_compat(decompressed_json)
		if not platform_data then
			return nil, "Failed to parse decompressed JSON data"
		end
		log(string.format("[Import] After decompression: has_verification=%s", tostring(platform_data.verification ~= nil)))
		if platform_data.verification then
			log(string.format("[Import] Verification has item_counts=%s, fluid_counts=%s",
				tostring(platform_data.verification.item_counts ~= nil),
				tostring(platform_data.verification.fluid_counts ~= nil)))
		end
	else
		platform_data = parsed_data
	end

	local source_parsed = VersionCompat.parse(platform_data.factorio_version)
	local source_bucket = source_parsed and source_parsed.bucket or nil
	local runtime_bucket = VersionCompat.runtime_bucket()
	log(string.format("[Import Queue] Version dispatch: source=%s (%s) runtime=%s",
		tostring(platform_data.factorio_version), tostring(source_bucket), tostring(runtime_bucket)))
	platform_data = VersionCompat.migrate(platform_data, source_bucket, runtime_bucket)

	local schema_ok, schema_err = VersionCompat.check_payload_schema(platform_data)
	if not schema_ok then
		log("[Import Queue] REFUSED payload: " .. tostring(schema_err))
		return nil, schema_err
	end

	local is_transfer = (platform_data._transferId or parsed_data._transferId) ~= nil
	local imported_schedule = platform_data
		and platform_data.platform
		and platform_data.platform.schedule
		or nil
	if is_transfer then
		if type(platform_data.platform) ~= "table" then
			return nil, "Transfer payload missing required platform metadata table"
		end
		local schedule_ok, schedule_err = PlatformSchedule.validate_transfer_payload(imported_schedule)
		if not schedule_ok then
			return nil, "Transfer payload missing/invalid platform schedule: " .. tostring(schedule_err)
		end
	end


	local force = game.forces[force_name] or game.forces.player

	local original_name = new_platform_name
	local name_was_missing = false
	if not new_platform_name or new_platform_name == "" then
		name_was_missing = true
		new_platform_name = "Imported Platform"
		game.print("[Import Warning] No platform name provided, assigning default name", {1, 0.5, 0})
	end

	local function platform_name_exists(name)
		for _, platform in pairs(force.platforms) do
			if platform.name == name then
				return true
			end
		end
		return false
	end

	local final_name = new_platform_name
	if platform_name_exists(new_platform_name) then
		local counter = 1
		while platform_name_exists(string.format("%s #%d", new_platform_name, counter)) do
			counter = counter + 1
		end
		final_name = string.format("%s #%d", new_platform_name, counter)
		game.print(string.format("[Import Warning] Platform '%s' already exists, renamed to '%s'",
			new_platform_name, final_name), {1, 0.5, 0})
	elseif name_was_missing then
		local counter = 1
		while platform_name_exists(string.format("Imported Platform #%d", counter)) do
			counter = counter + 1
		end
		final_name = string.format("Imported Platform #%d", counter)
		game.print(string.format("[Import Warning] Assigned name: '%s'", final_name), {1, 0.5, 0})
	end

	local target_planet = platform_data._targetPlanet or parsed_data._targetPlanet or "nauvis"
	local ok_create, new_platform = pcall(function()
		return force.create_space_platform({
			name = final_name,
			planet = target_planet,
			starter_pack = "space-platform-starter-pack"
		})
	end)

	if not ok_create then
		log(string.format("[Import Queue] FAILED: create_space_platform errored for planet='%s': %s",
			target_planet, tostring(new_platform)))
		return nil, string.format("Failed to create platform on planet '%s' (invalid or unavailable on this instance)", target_planet)
	end

	if not new_platform or not new_platform.valid then
		log(string.format("[Import Queue] FAILED: Could not create platform '%s'", final_name))
		return nil, "Failed to create platform"
	end

	log(string.format("[Import Queue] Platform created: '%s' (index=%s, planet=%s)", final_name, tostring(new_platform.index), target_planet))

	local ok, err = pcall(function()
		new_platform.apply_starter_pack()
	end)

	if not ok then
		log(string.format("[Import Queue] FAILED: apply_starter_pack errored for platform '%s': %s",
			final_name, tostring(err)))
		GameUtils.delete_platform(new_platform)
		return nil, "Failed to apply starter pack: " .. tostring(err)
	end

	if not new_platform.surface or not new_platform.surface.valid then
		GameUtils.delete_platform(new_platform)
		log(string.format("[Import Queue] FAILED: Platform '%s' surface not valid after activation", final_name))
		return nil, "Platform surface not valid after activation"
	end

	local starter_entities = new_platform.surface.find_entities_filtered({})
	log(string.format("[Import Queue] Starter pack applied: %d entities on surface (platform '%s') — destroying non-hub starters", #starter_entities, final_name))
	for _, ent in ipairs(starter_entities) do
		if ent.valid then
			if ent.name == "space-platform-hub" then
				log(string.format("[Import Queue]   Keeping starter entity: %s at (%.1f, %.1f)", ent.name, ent.position.x, ent.position.y))
			else
				log(string.format("[Import Queue]   Destroying starter entity: %s at (%.1f, %.1f)", ent.name, ent.position.x, ent.position.y))
				ent.destroy()
			end
		end
	end

	if is_transfer then
		new_platform.paused = true
		log(string.format("[Import] Platform %s PAUSED to prevent fuel consumption during import", new_platform.name))
	end

	local gateway_target = platform_data and platform_data.platform and platform_data.platform.gateway_target or nil
	if gateway_target and not Gateway.is_gateway(gateway_target) then
		log(string.format("[Gateway] Ignoring gateway_target '%s' — not a gateway on this instance",
			tostring(gateway_target)))
		gateway_target = nil
	end

	if gateway_target then
		if not is_transfer then
			new_platform.paused = true
		end
		local ok_unlock, err_unlock = pcall(function() force.unlock_space_location(gateway_target) end)
		if not ok_unlock then
			log(string.format("[Gateway] unlock_space_location('%s') failed before creation-park for %s: %s",
				tostring(gateway_target), final_name, tostring(err_unlock)))
		end
		local ok_loc, err_loc = pcall(function() new_platform.space_location = gateway_target end)
		if ok_loc then
			log(string.format("[Gateway] Platform %s parked at gateway '%s' at CREATION (pre-restoration)",
				final_name, gateway_target))
		else
			log(string.format("[Gateway] CREATION park FAILED for %s at '%s': %s — platform remains paused at its default location",
				final_name, tostring(gateway_target), tostring(err_loc)))
		end
	end
	if gateway_target and imported_schedule then
		local stripped = Gateway.strip_gateway_records(imported_schedule)
		if stripped then
			log(string.format("[Gateway] Gateway transfer to '%s' — stripping gateway hop (records %d -> %d)",
				gateway_target, #(imported_schedule.records or {}), #stripped.records))
			imported_schedule = stripped
		else
			log(string.format("[Gateway] Gateway transfer to '%s' — gateway is the only schedule record, keeping it",
				gateway_target))
		end
	end

	if imported_schedule then
		local filtered_schedule, dropped_stops = PlatformSchedule.filter_for_import(imported_schedule)
		if dropped_stops and #(dropped_stops.stations or {}) > 0 then
			if dropped_stops.skipped_empty then
				log(string.format("[Schedule] %d unroutable stop(s) on this instance (%s) but ALL records are unroutable — kept original schedule to avoid an empty (invalid) schedule",
					#dropped_stops.stations, table.concat(dropped_stops.stations, ", ")))
			else
				log(string.format("[Schedule] stripped %d unroutable stop(s) not present on this instance: %s",
					#dropped_stops.stations, table.concat(dropped_stops.stations, ", ")))
				imported_schedule = filtered_schedule
			end
		end
		local schedule_apply_ok, schedule_apply_err = PlatformSchedule.apply(new_platform, imported_schedule)
		if not schedule_apply_ok then
			GameUtils.delete_platform(new_platform)
			return nil, "Failed to restore platform schedule: " .. tostring(schedule_apply_err)
		end
		local imported_schedule_summary = PlatformSchedule.summarize(imported_schedule)
		log(string.format("[Import] Restored platform schedule: records=%d, interrupts=%d, group=%s",
			imported_schedule_summary.record_count,
			imported_schedule_summary.interrupt_count,
			tostring(imported_schedule_summary.group)))
	elseif is_transfer then
		GameUtils.delete_platform(new_platform)
		return nil, "Transfer payload missing required platform schedule"
	end

	local total_items = 0
	local total_fluids = 0
	if platform_data.verification then
		total_items = Util.sum_items(platform_data.verification.item_counts or {})
		total_fluids = Util.sum_fluids(platform_data.verification.fluid_counts or {})
	end

	PhaseProfiler.stop(job_id, "queue_setup")

	storage.async_jobs[job_id] = {
		type = "import",
		job_id = job_id,
		platform_name = new_platform.name,
		force_name = force_name,
		requester = requester_name,
		started_tick = game.tick,

		platform_data = platform_data,
		source_bucket = source_bucket,
		runtime_bucket = runtime_bucket,
		target_surface = new_platform.surface,
		tiles_to_place = platform_data.tiles or {},
		tiles_placed = false,
		entities_to_create = (function()
			local ordered, proxies = {}, {}
			for _, record in ipairs(platform_data.entities or {}) do
				if record.type == "item-request-proxy" then proxies[#proxies + 1] = record
				else ordered[#ordered + 1] = record end
			end
			for _, record in ipairs(proxies) do ordered[#ordered + 1] = record end
			return ordered
		end)(),
		total_entities = #(platform_data.entities or {}),
		total_items = total_items,
		total_fluids = math.floor(total_fluids),
		current_index = 0,

		entity_map = {},

		frozen_states = platform_data.frozen_states or {},

		transfer_id = platform_data._transferId or parsed_data._transferId,
		source_instance_id = platform_data._sourceInstanceId or parsed_data._sourceInstanceId,
		operation_id = platform_data._operationId or parsed_data._operationId,

		target_platform = new_platform,
		imported_schedule = imported_schedule,
		gateway_target = gateway_target,

		metrics = {
			delivery_started_tick = receive_timing and receive_timing.delivery_started_tick or nil,
			delivery_completed_tick = receive_timing and receive_timing.delivery_completed_tick or nil,
			tiles_started_tick = nil,
			tiles_completed_tick = nil,
			entities_started_tick = nil,
			entities_completed_tick = nil,
			fluids_started_tick = nil,
			fluids_completed_tick = nil,
			belts_started_tick = nil,
			belts_completed_tick = nil,
			state_started_tick = nil,
			state_completed_tick = nil,
			validation_started_tick = nil,
			validation_completed_tick = nil,
			tiles_placed = 0,
			entities_created = 0,
			entities_failed = 0,
			entities_skipped = 0,
			entities_mapped = 0,
			fluids_restored = 0,
			belt_items_restored = 0,
			circuits_connected = 0,
		}
	}

	log(string.format("[Import Job] Created job %s for platform '%s' (transfer_id=%s, source=%s, operation_id=%s)",
		job_id, new_platform.name,
		tostring(storage.async_jobs[job_id].transfer_id),
		tostring(storage.async_jobs[job_id].source_instance_id),
		tostring(storage.async_jobs[job_id].operation_id)))

	return job_id
end

function ImportPipeline.process_batch(job, get_batch_size, should_show_progress)
	if not job.target_surface or not job.target_surface.valid then
		log(string.format("[Import Batch] ABORT: Target surface became invalid for job %s (platform '%s')",
			job.job_id, job.platform_name))
		game.print("[Import Error] Target surface became invalid", {1, 0, 0})
		return true
	end

	job.metrics = job.metrics or {}

	if not job.force_bonuses_synced then
		job.force_bonuses_synced = true
		local fd = job.platform_data and job.platform_data.force_data
		if fd then
			job.force_bonuses_mismatch = {}
			local force_names = {}
			if job.force_name then force_names[job.force_name] = true end
			for _, ed in ipairs(job.entities_to_create or {}) do
				force_names[ed.force or "player"] = true
			end
			for fname in pairs(force_names) do
				local dest = game.forces[fname]
				if dest and dest.valid then
					for _, prop in ipairs(GameUtils.FORCE_SYNC_PROPS) do
						local src = fd[prop] or 0
						local cur = dest[prop]
						if src > cur then
							dest[prop] = src
							table.insert(job.force_bonuses_mismatch,
								{ force = dest.name, property = prop, source = src, destination = cur, synced_to = src })
							log(string.format("[Import] Force '%s' %s raised %d->%d to match source platform",
								dest.name, prop, cur, src))
						end
					end
				end
			end
		else
			log("[Import] payload has no force_data (pre-fix export) — dest force bonuses NOT synced; "
				.. "held items may be capped if the dest is under-researched")
		end
	end

	if not job.tiles_placed then
		if not job.metrics.tiles_started_tick then
			PhaseRecorder.start(job, "tiles")
		end
	end
	TileRestoration.process(job)
	if job.tiles_placed and not job.metrics.tiles_completed_tick then
		PhaseRecorder.stop(job, "tiles")
		job.metrics.tiles_placed = #(job.tiles_to_place or {})
	end

	PlatformHubMapping.process(job)

	if not job.beacons_placed and job.tiles_placed then
		PhaseRecorder.start(job, "beacons")
		local beacons_created = 0
		local beacons_skipped = 0
		for _, entity_data in ipairs(job.entities_to_create) do
			if entity_data and entity_data.name and not entity_data._beacon_placed then
				local proto = prototypes.entity[entity_data.name]
				if proto and proto.type == "beacon" then
					local entity = Deserializer.create_entity(job.target_surface, entity_data)
					if entity and entity.valid then
						if entity_data.entity_id then
							job.entity_map[entity_data.entity_id] = entity
						end
						entity_data._beacon_placed = true
						beacons_created = beacons_created + 1
					else
						beacons_skipped = beacons_skipped + 1
					end
				end
			end
		end
		job.beacons_placed = true
		PhaseRecorder.stop(job, "beacons")
		if beacons_created > 0 or beacons_skipped > 0 then
			log(string.format("[Import] Beacon pre-placement: %d placed, %d failed (tick %d)", beacons_created, beacons_skipped, game.tick))
		end
	end

	if not job.metrics.entities_started_tick and job.tiles_placed then
		PhaseRecorder.start(job, "entities")
	end
	local complete = EntityCreation.process_batch(job, get_batch_size, should_show_progress)
	if complete and not job.metrics.entities_completed_tick then
		PhaseRecorder.stop(job, "entities")
		local mapped = 0
		for _ in pairs(job.entity_map or {}) do mapped = mapped + 1 end
		job.metrics.entities_mapped = mapped
	end

	return complete
end

return ImportPipeline
