-- FactorioSurfaceExport - Import Pipeline
-- Handles import job creation (queuing) and per-tick entity placement batch processing.

local Deserializer = require("modules/surface_export/core/deserializer")
local Util = require("modules/surface_export/utils/util")
local PlatformSchedule = require("modules/surface_export/utils/platform-schedule")
local TileRestoration = require("modules/surface_export/import_phases/tile_restoration")
local PlatformHubMapping = require("modules/surface_export/import_phases/platform_hub_mapping")
local EntityCreation = require("modules/surface_export/import_phases/entity_creation")
local PhaseProfiler = require("modules/surface_export/utils/phase-profiler")
local GameUtils = require("modules/surface_export/utils/game-utils")
local VersionCompat = require("modules/surface_export/utils/version-compat")
local Gateway = require("modules/surface_export/core/gateway")

local ImportPipeline = {}

--- Queue an import job from file
--- @param filename string: Filename in script-output/platform_exports/
--- @param new_platform_name string
--- @param force_name string
--- @param requester_name string|nil
--- @return string|nil, string|nil: job_id or error
function ImportPipeline.queue_from_file(filename, new_platform_name, force_name, requester_name)
	-- Read file from script-output/platform_exports/
	local filepath = "platform_exports/" .. filename
	local json_data, err = Util.read_file_compat(filepath)

	if not json_data then
		return nil, "Failed to read file '" .. filename .. "': " .. (err or "unknown error")
	end

	-- Use existing queue logic
	return ImportPipeline.queue(json_data, new_platform_name, force_name, requester_name)
end

--- Queue an import job from JSON string
--- @param json_data string: JSON string of platform data
--- @param new_platform_name string
--- @param force_name string
--- @param requester_name string|nil
--- @return string|nil, string|nil: job_id or error
function ImportPipeline.queue(json_data, new_platform_name, force_name, requester_name, receive_timing)
	storage.async_job_id_counter = storage.async_job_id_counter + 1
	local job_id = "import_" .. storage.async_job_id_counter

	log(string.format("[Import Queue] job_id=%s, platform='%s', force=%s, requester=%s, data_type=%s",
		job_id, tostring(new_platform_name), tostring(force_name), tostring(requester_name), type(json_data)))
	if type(json_data) == "string" then
		log(string.format("[Import Queue] JSON string size: %d bytes", #json_data))
	end

	-- Initialize phase profilers and measure decompression + platform setup time
	PhaseProfiler.init(job_id, {
		"queue_setup", "beacons",
		"hub_restore", "belts", "state",
		"inventories", "validation", "activation", "fluids", "loss_analysis",
	})
	PhaseProfiler.start(job_id, "queue_setup")

	-- First, parse if it's a JSON string
	local parsed_data
	if type(json_data) == "string" then
		parsed_data = Util.json_to_table_compat(json_data)
		if not parsed_data then
			return nil, "Failed to parse JSON data"
		end
	else
		-- Already a table
		parsed_data = json_data
	end

	-- Now check if the parsed data is compressed
	local platform_data
	if parsed_data.compressed and parsed_data.payload then
		-- Compressed format: decode base64 and inflate
		log(string.format("[Decompression] Decompressing import data (%d bytes compressed)", #parsed_data.payload))
		local decompressed_json = helpers.decode_string(parsed_data.payload)
		if not decompressed_json then
			return nil, "Failed to decompress data"
		end
		log(string.format("[Decompression] Decompressed to %d bytes", #decompressed_json))

		-- Parse the decompressed JSON
		platform_data = Util.json_to_table_compat(decompressed_json)
		if not platform_data then
			return nil, "Failed to parse decompressed JSON data"
		end
		-- Debug: Check if verification exists after decompression
		log(string.format("[Import] After decompression: has_verification=%s", tostring(platform_data.verification ~= nil)))
		if platform_data.verification then
			log(string.format("[Import] Verification has item_counts=%s, fluid_counts=%s",
				tostring(platform_data.verification.item_counts ~= nil),
				tostring(platform_data.verification.fluid_counts ~= nil)))
		end
	else
		-- Uncompressed format - data is already the platform data
		platform_data = parsed_data
	end

	-- Version dispatch (SOURCE axis): the payload carries the engine version that produced it
	-- (factorio_version, stamped at export). Migrate its DATA SHAPE to the runtime engine's shape
	-- before any restoration reads it. Phase 1 is identity (only the "2.0" bucket exists), but the
	-- seam + the both-buckets log line are built now so a future cross-version mismatch is visible
	-- and phase 2 only has to register the migration. See utils/version-compat.lua.
	local source_parsed = VersionCompat.parse(platform_data.factorio_version)
	local source_bucket = source_parsed and source_parsed.bucket or nil
	local runtime_bucket = VersionCompat.runtime_bucket()
	log(string.format("[Import Queue] Version dispatch: source=%s (%s) runtime=%s",
		tostring(platform_data.factorio_version), tostring(source_bucket), tostring(runtime_bucket)))
	platform_data = VersionCompat.migrate(platform_data, source_bucket, runtime_bucket)

	-- Forward-only transfer schema cutover:
	-- Transfer imports must include full platform schedule payload.
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

	-- Entities are already sorted during export for proper placement order
	-- No need to re-sort on import

	local force = game.forces[force_name] or game.forces.player

	-- Handle missing platform name
	local original_name = new_platform_name
	local name_was_missing = false
	if not new_platform_name or new_platform_name == "" then
		name_was_missing = true
		new_platform_name = "Imported Platform"
		game.print("[Import Warning] No platform name provided, assigning default name", {1, 0.5, 0})
	end

	-- Check if platform name already exists and find unique name
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
		-- Assign numbered name for missing names
		local counter = 1
		while platform_name_exists(string.format("Imported Platform #%d", counter)) do
			counter = counter + 1
		end
		final_name = string.format("Imported Platform #%d", counter)
		game.print(string.format("[Import Warning] Assigned name: '%s'", final_name), {1, 0.5, 0})
	end

	-- Create new platform
	-- Check both platform_data (decompressed) and parsed_data (compressed format),
	-- mirroring the _transferId / _operationId handling below.
	local target_planet = platform_data._targetPlanet or parsed_data._targetPlanet or "nauvis"
	-- create_space_platform raises if the planet name is invalid or not present on this instance
	-- (e.g. mod mismatch). Guard it so a bad destination returns a clean error instead of crashing
	-- the instance (cf. Pitfall #25). The UI restricts choices, but RCON/API callers do not.
	-- Call via a closure: force.create_space_platform binds self on access, so it takes ONLY the
	-- table (passing force explicitly gives an "Expected 1 argument but 2 were given" error).
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

	-- Apply starter pack to activate surface immediately
	-- Platform needs starter pack to have a valid surface
	local ok, err = pcall(function()
		new_platform.apply_starter_pack()
	end)

	if not ok then
		log(string.format("[Import Queue] FAILED: apply_starter_pack errored for platform '%s': %s",
			final_name, tostring(err)))
		GameUtils.delete_platform(new_platform)
		return nil, "Failed to apply starter pack: " .. tostring(err)
	end

	-- Validate surface is now accessible
	if not new_platform.surface or not new_platform.surface.valid then
		GameUtils.delete_platform(new_platform)
		log(string.format("[Import Queue] FAILED: Platform '%s' surface not valid after activation", final_name))
		return nil, "Platform surface not valid after activation"
	end

	-- CRITICAL: Destroy all starter pack entities EXCEPT the hub.
	-- The hub is created automatically and cannot be re-created manually — we remap it via
	-- PlatformHubMapping and restore its inventories from export data.
	-- All other starter entities (thrusters, etc.) must be destroyed so they don't accumulate
	-- alongside the imported entities, causing item count inflation during validation.
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

	-- CRITICAL: For transfers, PAUSE the platform immediately to prevent thruster fuel consumption
	-- This stops the platform from using fuel during the multi-tick import process
	if is_transfer then
		new_platform.paused = true
		log(string.format("[Import] Platform %s PAUSED to prevent fuel consumption during import", new_platform.name))
	end

	-- Gateway transfer: the source carries an EXPLICIT gateway_target in the payload (a sibling of
	-- platform.schedule — NOT inferred from the schedule's current record). When present, strip the
	-- gateway hop(s) from the itinerary; the platform is placed at gateway_target, paused, at the very
	-- end of import (see import-completion.lua) so it arrives parked instead of flying the schedule.
	-- Absent ⇒ ordinary transfer, schedule untouched (so a normal /transfer-platform of a gateway-parked
	-- platform is NOT treated as a gateway arrival — fixes the over-/under-fire of schedule inference).
	local gateway_target = platform_data and platform_data.platform and platform_data.platform.gateway_target or nil
	-- Defensive: ignore a stale/bogus target that isn't a real gateway on THIS instance.
	if gateway_target and not Gateway.is_gateway(gateway_target) then
		log(string.format("[Gateway] Ignoring gateway_target '%s' — not a gateway on this instance",
			tostring(gateway_target)))
		gateway_target = nil
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

	-- Restore platform schedule (records + interrupts + group) from payload.
	if imported_schedule then
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
		-- Defensive guard: transfers should never reach this state due to strict validation above.
		GameUtils.delete_platform(new_platform)
		return nil, "Transfer payload missing required platform schedule"
	end

	-- Calculate item and fluid totals from verification data if available
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

		-- Import state
		platform_data = platform_data,
		-- Engine version that produced this payload (SOURCE axis) vs the running engine (RUNTIME axis).
		-- Equal in phase 1; recorded so cross-version handling/diagnostics can key off them later.
		source_bucket = source_bucket,
		runtime_bucket = runtime_bucket,
		target_surface = new_platform.surface,
		tiles_to_place = platform_data.tiles or {},
		tiles_placed = false,
		entities_to_create = platform_data.entities or {},
		total_entities = #(platform_data.entities or {}),
		total_items = total_items,
		total_fluids = math.floor(total_fluids),  -- Fluids can be fractional
		current_index = 0,

		-- Entity map for post-processing (circuit connections, etc.)
		entity_map = {},

		-- CRITICAL: frozen_states contains original active/disabled states from export
		-- Used to restore entities to their pre-export state in final import step
		frozen_states = platform_data.frozen_states or {},

		-- Transfer metadata (if this is a transfer import)
		-- Check both parsed_data (compressed format) and platform_data (decompressed)
		transfer_id = platform_data._transferId or parsed_data._transferId,
		source_instance_id = platform_data._sourceInstanceId or parsed_data._sourceInstanceId,
		operation_id = platform_data._operationId or parsed_data._operationId,

		-- Store platform reference for unpausing after validation
		target_platform = new_platform,
		imported_schedule = imported_schedule,
		-- Gateway to park at (nil for normal transfers; explicit, from the payload). When set, import
		-- completion parks the platform AT this gateway, paused, instead of unpausing it to fly.
		gateway_target = gateway_target,

		-- ========== PHASE METRICS TRACKING ==========
		-- Track timing and counts for each import phase
		metrics = {
			-- Chunked-receive (delivery) window — populated only for RCON_CHUNKED imports so the
			-- waterfall can show data delivery as its own span. Pure game.tick reads (freeze-safe).
			delivery_started_tick = receive_timing and receive_timing.delivery_started_tick or nil,
			delivery_completed_tick = receive_timing and receive_timing.delivery_completed_tick or nil,
			-- Phase timing (tick numbers)
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
			-- Counts
			tiles_placed = 0,
			entities_created = 0,
			entities_failed = 0,
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

--- Process one batch of an import job (tile placement + entity creation)
--- @param job table: Job data
--- @param get_batch_size function: returns batch size (supports sync mode)
--- @param should_show_progress function: returns bool
--- @return boolean: true if entity creation is complete
function ImportPipeline.process_batch(job, get_batch_size, should_show_progress)
	-- Validate surface is still valid
	if not job.target_surface or not job.target_surface.valid then
		log(string.format("[Import Batch] ABORT: Target surface became invalid for job %s (platform '%s')",
			job.job_id, job.platform_name))
		game.print("[Import Error] Target surface became invalid", {1, 0, 0})
		return true  -- Abort job
	end

	-- Initialize metrics if needed
	job.metrics = job.metrics or {}

	-- Phase 0: Pre-hydration force synchronization (one-shot, RAISE-ONLY).
	-- Inserter HAND CAPACITY is governed by the FORCE the inserter is on (its research bonuses), not by entity
	-- data, and the plugin doesn't transfer the tech tree. The source force's bonuses ride in the payload
	-- (export-pipeline force_data); replicate them onto the destination force(s) BEFORE any entity is created or
	-- any held item is seated, so a less-researched dest can physically hold what the source held. Without this,
	-- set_stack/count silently clamp to the dest's lower capacity and the held items are genuinely unplaceable
	-- (the held-item root cause; see Pitfall #29).
	-- Raise EVERY distinct force the entities land on (the deserializer creates each entity on
	-- entity_data.force or "player"), not just job.force_name — they normally match, but syncing only the
	-- platform force would leave a differently-forced inserter under-capacity → silent held-item loss.
	-- RAISE-ONLY (math.max semantics): never LOWER a dest bonus — lowering it would eject items from OTHER
	-- platforms' inserters already on that force. Verified durable: once seated, items are NOT ejected even if
	-- the bonus later resets (reset_technology_effects), so no post-commit loss path.
	if not job.force_bonuses_synced then
		job.force_bonuses_synced = true
		local fd = job.platform_data and job.platform_data.force_data
		if fd then
			job.force_bonuses_mismatch = {}
			-- Distinct set of forces the inserters will be created on, plus the platform force defensively.
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
			-- Old (pre-fix) payload carries no force_data → sync skipped. One-line notice so a future gate
			-- failure on an under-researched dest is self-explaining rather than a mystery.
			log("[Import] payload has no force_data (pre-fix export) — dest force bonuses NOT synced; "
				.. "held items may be capped if the dest is under-researched")
		end
	end

	-- Phase 1: Tile Restoration (track timing)
	if not job.tiles_placed then
		if not job.metrics.tiles_started_tick then
			job.metrics.tiles_started_tick = game.tick
		end
	end
	TileRestoration.process(job)
	if job.tiles_placed and not job.metrics.tiles_completed_tick then
		job.metrics.tiles_completed_tick = game.tick
		job.metrics.tiles_placed = #(job.tiles_to_place or {})
	end

	-- Phase 2: Platform Hub Mapping
	PlatformHubMapping.process(job)

	-- Phase 2b: Beacon Pre-Placement (synchronous, runs once before entity batching)
	-- Beacons MUST exist before the machines they affect are created. If a machine is placed
	-- first, the engine registers it with no beacon linkage and crafting_speed stays at base
	-- value — the beacon-boosted set_stack() cap is never applied, causing item overflow.
	-- This phase places ALL beacons (including modded types) in one tick, unconditionally.
	-- Uses prototypes[name].type to detect beacons so any mod's beacon variant is covered.
	if not job.beacons_placed and job.tiles_placed then
		PhaseProfiler.start(job.job_id, "beacons")
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
						entity_data._beacon_placed = true  -- Skip in main batch loop
						beacons_created = beacons_created + 1
					else
						beacons_skipped = beacons_skipped + 1
					end
				end
			end
		end
		job.beacons_placed = true
		PhaseProfiler.stop(job.job_id, "beacons")
		if beacons_created > 0 or beacons_skipped > 0 then
			log(string.format("[Import] Beacon pre-placement: %d placed, %d failed (tick %d)", beacons_created, beacons_skipped, game.tick))
		end
	end

	-- Phase 3: Entity Creation Batch (track timing)
	if not job.metrics.entities_started_tick and job.tiles_placed then
		job.metrics.entities_started_tick = game.tick
	end
	local complete = EntityCreation.process_batch(job, get_batch_size, should_show_progress)
	if complete and not job.metrics.entities_completed_tick then
		job.metrics.entities_completed_tick = game.tick
		-- Count created entities from entity_map
		local created = 0
		for _ in pairs(job.entity_map or {}) do created = created + 1 end
		job.metrics.entities_created = created
		job.metrics.entities_failed = job.total_entities - created
	end

	return complete
end

return ImportPipeline
