local EntityScanner = require("modules/surface_export/export_scanners/entity-scanner")
local EntityHandlers = require("modules/surface_export/export_scanners/entity-handlers")
local InventoryScanner = require("modules/surface_export/export_scanners/inventory-scanner")
local FluidRegistry = require("modules/surface_export/export_scanners/fluid-registry")
local VersionCompat = require("modules/surface_export/utils/version-compat")
local Verification = require("modules/surface_export/validators/verification")
local BeltRestoration = require("modules/surface_export/import_phases/belt_restoration")
local Util = require("modules/surface_export/utils/util")
local GameUtils = require("modules/surface_export/utils/game-utils")
local SurfaceLock = require("modules/surface_export/utils/surface-lock")
local TileScanner = require("modules/surface_export/export_scanners/tile_scanner")
local DebugExport = require("modules/surface_export/utils/debug-export")
local PlatformSchedule = require("modules/surface_export/utils/platform-schedule")
local clusterio_api = require("modules/clusterio/api")
local PhaseProfiler = require("modules/surface_export/utils/phase-profiler")
local TransactionHistory = require("modules/surface_export/utils/transaction-history")
local JobResults = require("modules/surface_export/core/job-results")
local CensusAccumulator = require("modules/surface_export/export_scanners/census-accumulator")
local BlueprintDiff = require("modules/surface_export/export_scanners/blueprint-diff")
local ExportCache = require("modules/surface_export/utils/export-cache")
local ImportPipeline = require("modules/surface_export/core/import-pipeline")

local ExportPipeline = {}

local function maybe_inject_census_omission(entity_data)
	local cfg = storage.surface_export_config
	if not (cfg and cfg.test_force_census_omission) then return end
	local invs = entity_data and entity_data.specific_data and entity_data.specific_data.inventories
	if not invs then return end
	for _, inv in ipairs(invs) do
		if inv.items and #inv.items > 0 then
			local removed = table.remove(inv.items, 1)
			cfg.test_force_census_omission = nil
			log(string.format(
				"[Census][test hook] test_force_census_omission dropped serialized stack '%s' x%d from entity_id=%s",
				tostring(removed and removed.name),
				tonumber(removed and removed.count) or 0,
				tostring(entity_data.entity_id)))
			return
		end
	end
end

local function sort_entities_for_placement(entities)
	local function get_priority(entity_or_data)
		local name = entity_or_data.name or ""
		local type_name = entity_or_data.type or ""

		if type_name == "straight-rail" or type_name == "curved-rail" then
			return 1
		end

		if type_name == "underground-belt" then
			local belt_type = entity_or_data.belt_to_ground_type
			if belt_type == "input" then
				return 2
			else
				return 3
			end
		end

		if type_name == "pipe-to-ground" then
			return 4
		end

		return 5
	end

	local sorted = {}
	for _, entity in ipairs(entities) do
		table.insert(sorted, entity)
	end

	table.sort(sorted, function(a, b)
		local priority_a = get_priority(a)
		local priority_b = get_priority(b)

		if priority_a ~= priority_b then
			return priority_a < priority_b
		end

		if a.position and b.position then
			local pos_a = a.position
			local pos_b = b.position
			if pos_a.x ~= pos_b.x then
				return pos_a.x < pos_b.x
			end
			return pos_a.y < pos_b.y
		end

		return false
	end)

	return sorted
end

local function handle_pending_file_write(export_id)
	if not storage.pending_file_writes or not storage.pending_file_writes[export_id] then
		return
	end

	local file_request = storage.pending_file_writes[export_id]
	local filename = file_request.filename

	if not filename then
		filename = string.format("platform_exports/%s.json", export_id)
	end

	local export_entry = storage.platform_exports[export_id]
	if export_entry then
		local json_string = export_entry.json_string
		if not json_string then
			json_string = Util.encode_json_compat(export_entry)
		end

		if json_string then
			local wrote_ok, write_err = Util.write_file_compat(filename, json_string, false)
			if wrote_ok then
				log(string.format("[Export] File written: %s (%d bytes)", filename, #json_string))
				game.print(string.format("[Export] File written: script-output/%s", filename), {0, 1, 0})
			else
				log(string.format("[Export ERROR] write_file failed for %s: %s", filename, tostring(write_err)))
				game.print(string.format("[Export ERROR] Could not write file %s", filename), {1, 0.3, 0})
			end
		else
			log(string.format("[Export ERROR] Failed to serialize export for file write: %s", export_id))
		end
	end

	storage.pending_file_writes[export_id] = nil
end

function ExportPipeline.queue(platform_index, force_name, requester_name, destination_instance_id, gateway_target, clone_dest_name)
	storage.async_job_id_counter = storage.async_job_id_counter + 1
	local job_counter = storage.async_job_id_counter

	local force = game.forces[force_name]
	if not force or not force.platforms[platform_index] then
		log(string.format("[Export Queue] FAILED: Platform index %s not found for force '%s'", tostring(platform_index), force_name))
		return nil, "Platform not found"
	end

	local platform = force.platforms[platform_index]

	local safe_name = platform.name:gsub("[^%w%-]", "-")

	local job_id = string.format("%03d_%s", job_counter, safe_name)

	log(string.format("[Export Queue] job_id=%s, platform_index=%s, force=%s, requester=%s, dest_instance_id=%s (type=%s)",
		job_id, tostring(platform_index), force_name, tostring(requester_name),
		tostring(destination_instance_id), type(destination_instance_id)))
	local surface = platform.surface
	if not surface or not surface.valid then
		return nil, "Platform surface not valid"
	end

	if not GameUtils.platform_has_hub(platform) then
		return nil, string.format(
			"Platform '%s' (index %d) has no hub — not a transferable platform",
			platform.name, platform_index)
	end


	local lock_opts = {
		kind = destination_instance_id and "transfer" or "export",
		job_id = job_id,
		expires_tick = game.tick + SurfaceLock.DEFAULT_TRANSFER_LOCK_TTL_TICKS,
	}

	local lock_success, lock_err = SurfaceLock.lock_platform(platform, force, lock_opts)
	if not lock_success then
		if lock_err ~= "Platform already locked" then
			return nil, "Failed to lock platform: " .. (lock_err or "unknown error")
		end
		log(string.format("[Export] Platform %s was already locked, continuing with export", platform.name))
	else
		game.print(string.format("[Export] Locked platform %s for stable export...", platform.name), {1, 0.8, 0})
	end

	local platform_schedule, schedule_err = PlatformSchedule.capture(platform, platform.hub)
	if not platform_schedule then
		SurfaceLock.unlock_platform(platform.index)
		return nil, "Failed to capture platform schedule: " .. tostring(schedule_err)
	end
	local schedule_summary = PlatformSchedule.summarize(platform_schedule)
	log(string.format("[Export] Captured platform schedule: records=%d, interrupts=%d, group=%s",
		schedule_summary.record_count,
		schedule_summary.interrupt_count,
		tostring(schedule_summary.group)))

	local entities = surface.find_entities_filtered({})
	local fluid_registry = FluidRegistry.new()

	entities = sort_entities_for_placement(entities)

	local tiles = TileScanner.scan_surface(surface)
	log(string.format("[Export] Scanned %d tiles and %d entities from platform %s (sorted for placement, locked)", #tiles, #entities, platform.name))

	storage.async_jobs[job_id] = {
		type = "export",
		job_id = job_id,
		platform_index = platform_index,
		platform_name = platform.name,
		force_name = force_name,
		requester = requester_name,
		destination_instance_id = destination_instance_id,
		clone_dest_name = clone_dest_name,
		started_tick = game.tick,
		surface = surface,

		entities = entities,
		total_entities = #entities,
		current_index = 0,
		belt_entities = {},
		census = CensusAccumulator.new(fluid_registry),
		fluid_registry = fluid_registry,
		export_data = {
			schema_version = VersionCompat.PAYLOAD_SCHEMA_VERSION,
			factorio_version = script.active_mods.base,
			platform_name = platform.name,
			force_name = force_name,
			tick = game.tick,
			timestamp = Util.format_timestamp(game.tick),
			platform = {
				name = platform.name,
				force = force_name,
				index = platform_index,
				paused = platform.paused == true,
				schedule = platform_schedule,
				gateway_target = gateway_target,
			},
			tiles = tiles,
			entities = {},
			stats = {
				entity_count = #entities,
				tile_count = #tiles,
				started_tick = game.tick
			}
		}
	}

	PhaseProfiler.init(job_id, {"completion", "total"})
	PhaseProfiler.start(job_id, "total")
	return job_id
end

function ExportPipeline.process_batch(job, get_batch_size, should_show_progress)
	local batch_size = get_batch_size()
	local start_index = job.current_index + 1
	local end_index = math.min(start_index + batch_size - 1, job.total_entities)

	EntityHandlers.skip_belt_items = true
	InventoryScanner.fluid_registry = job.fluid_registry
	local batch_ok, batch_err = pcall(function()
		for i = start_index, end_index do
			local entity = job.entities[i]
			if EntityScanner.is_exportable_entity(entity) then
				local entity_data = EntityScanner.serialize_entity(entity)
				if entity_data then
					maybe_inject_census_omission(entity_data)

					table.insert(job.export_data.entities, entity_data)

					local category = Util.get_entity_category(entity)
					if GameUtils.BELT_ENTITY_TYPES[category] then
						local serialized_index = #job.export_data.entities
						job.belt_entities[serialized_index] = entity
					else
						CensusAccumulator.record(job.census, entity, entity_data)
					end
				end
			end
		end
	end)
	EntityHandlers.skip_belt_items = false
	InventoryScanner.fluid_registry = nil
	if not batch_ok then error(batch_err) end

	job.current_index = end_index

	if should_show_progress() and end_index % (batch_size * 10) == 0 then
		local progress = math.floor((end_index / job.total_entities) * 100)
		game.print(string.format("[Export %s] Progress: %d%% (%d/%d entities)",
			job.platform_name, progress, end_index, job.total_entities))
	end

	return job.current_index >= job.total_entities
end

function ExportPipeline.complete(job)
	local export_id = job.job_id

	PhaseProfiler.start(job.job_id, "completion")

	storage.platform_exports = storage.platform_exports or {}

	local belt_scan_count = 0
	local belt_item_total = 0
	local belt_pairs = {}
	for serialized_index, live_entity in pairs(job.belt_entities or {}) do
		if live_entity and live_entity.valid then
			local belt_items = InventoryScanner.extract_belt_items(live_entity)
			local entity_data = job.export_data.entities[serialized_index]
			if entity_data then
				belt_pairs[#belt_pairs + 1] = { entity = live_entity, id = entity_data.entity_id }
				entity_data.specific_data = entity_data.specific_data or {}
				entity_data.specific_data.items = belt_items
				CensusAccumulator.record(job.census, live_entity, entity_data)
				belt_scan_count = belt_scan_count + 1
				for _, line_data in ipairs(belt_items) do
					for _ in ipairs(line_data.items or {}) do
						belt_item_total = belt_item_total + 1
					end
				end
			end
		else
			log(string.format("[Belt Scan] WARNING: Belt entity at index %d became invalid before atomic scan",
				serialized_index))
		end
	end
	log(string.format("[Export] Atomic belt scan: %d belts scanned, %d item stacks captured (single tick)",
		belt_scan_count, belt_item_total))
	if #belt_pairs > 0 then
		local sg_ok, side_groups = pcall(BeltRestoration.capture_side_groups, belt_pairs)
		if sg_ok and side_groups then
			job.export_data.belt_side_groups = side_groups
			log(string.format("[Export] Belt side partition: %d side groups captured (same tick)", #side_groups))
		elseif not sg_ok then
			log("[Export] WARNING: capture_side_groups threw: " .. tostring(side_groups)
				.. " — payload carries NO side partition; a belt-bearing import will REFUSE it (no legacy fallback exists)")
		end
	end

	local ground_items = EntityScanner.scan_items_on_ground(job.surface)
	for _, ground_item in ipairs(ground_items) do
		table.insert(job.export_data.entities, ground_item)
	end
	log(string.format("[Export] Atomic ground-item scan: %d loose item stack(s) captured", #ground_items))

	job.export_data.fluid_segments = FluidRegistry.list(job.fluid_registry)

	local item_counts = Verification.count_all_items(job.export_data.entities)
	local fluid_counts = Verification.count_fluid_segments(job.export_data.fluid_segments)
	log(string.format("[Export] Generated verification from serialized data (%d item types, %d fluid types, %d fluid segments)",
		table_size(item_counts), table_size(fluid_counts), #job.export_data.fluid_segments))
	job.export_data.verification = {
		item_counts = item_counts,
		fluid_counts = fluid_counts,
	}

	job.census_verdict = CensusAccumulator.verdict(job.census)
	ExportPipeline.run_blueprint_diff(job)
	ExportPipeline.report_property_findings(job)
	if job.destination_instance_id then
		if not job.census_verdict.ok then
			ExportPipeline.abort_transfer_on_census_mismatch(job)
			return
		end
		DebugExport.export_census_pass(job.census_verdict, job.platform_name)
	else
		job.export_data.census_verdict = job.census_verdict
		if not job.census_verdict.ok then
			log(string.format(
				"[Census][WARN] Source census MISMATCH on non-transfer export '%s': %d mismatch row(s) — exporting anyway (no source-delete risk)",
				job.platform_name, #job.census_verdict.mismatches))
		end
	end

	local lock_data = storage.locked_platforms and storage.locked_platforms[job.platform_index]
	if lock_data and lock_data.frozen_states then
		job.export_data.frozen_states = lock_data.frozen_states
		log(string.format("[Export] Including frozen_states for %d entities",
			lock_data.frozen_count or 0))
	end

	local src_force = game.forces[job.force_name]
	if src_force and src_force.valid then
		local force_data = {}
		for _, prop in ipairs(GameUtils.FORCE_SYNC_PROPS) do
			force_data[prop] = src_force[prop]
		end
		job.export_data.force_data = force_data
	end

	log(string.format("[Export] Before compression: has_verification=%s", tostring(job.export_data.verification ~= nil)))
	if job.export_data.verification then
		log(string.format("[Export] Verification has item_counts=%s, fluid_counts=%s",
			tostring(job.export_data.verification.item_counts ~= nil),
			tostring(job.export_data.verification.fluid_counts ~= nil)))
	end

	local json_string = Util.encode_json_compat(job.export_data)
	local compressed = helpers.encode_string(json_string)

	if compressed then
		ExportCache.record(export_id, {
			compressed = true,
			compression = "deflate",
			payload = compressed,
			platform_name = job.export_data.platform_name,
			tick = job.export_data.tick,
			timestamp = job.export_data.timestamp,
			stats = job.export_data.stats,
			verification = job.export_data.verification
		})
		log(string.format("[Compression] Export %s: %d bytes → %d bytes (%.1f%% reduction)",
			export_id, #json_string, #compressed, (1 - #compressed / #json_string) * 100))
		log(string.format("[Export] Stored verification: item_counts=%s, fluid_counts=%s",
			tostring(job.export_data.verification and job.export_data.verification.item_counts ~= nil),
			tostring(job.export_data.verification and job.export_data.verification.fluid_counts ~= nil)))
	else
		ExportCache.record(export_id, job.export_data)
		log(string.format("[Compression Warning] Failed to compress export %s, storing uncompressed", export_id))
	end

	PhaseProfiler.stop(job.job_id, "completion")
	PhaseProfiler.stop(job.job_id, "total")

	local duration_ticks = game.tick - job.started_tick
	local duration_seconds = duration_ticks / 60
	local duration_ms = math.floor(duration_ticks * 16.67)
	local uncompressed_bytes = #json_string
	local compressed_bytes = compressed and #compressed or nil
	local compression_reduction_pct = nil
	if compressed_bytes and uncompressed_bytes > 0 then
		compression_reduction_pct = math.floor(((1 - (compressed_bytes / uncompressed_bytes)) * 1000) + 0.5) / 10
	end
	local exported_tile_count = #(job.export_data.tiles or {})
	local export_schedule_summary = PlatformSchedule.summarize(
		job.export_data.platform and job.export_data.platform.schedule or nil
	)

	if job.destination_instance_id then
		DebugExport.export_source_platform(job.export_data, job.platform_name)
	end

	local message = string.format(
		"[Export Complete] %s (%d entities in %.1fs) - ID: %s",
		job.platform_name, job.total_entities, duration_seconds, export_id
	)
	game.print(message, {0, 1, 0})
	log(message)

	if job.requester == "RCON" then
		rcon.print(string.format("EXPORT_COMPLETE:%s", export_id))
	end

	local perf = PhaseProfiler.get(job.job_id)
	if perf then
		local msg = {"", "[Perf] Export '", job.platform_name, "' (", job.total_entities, " entities):\n",
			"  Scanning:   ", math.floor(duration_ticks * 16.67), "ms (", duration_ticks, " ticks)\n",
			"  Completion (belt+verify+compress): ", perf.completion}
		game.print(msg)
		log({"", "[Perf] Export '", job.platform_name, "' (", job.total_entities, " entities, ",
			duration_ticks, " ticks) WALL CLOCK total: ", perf.total})
		log({"", "[Perf] Export '", job.platform_name, "' completion phase (belt+verify+compress): ",
			perf.completion})
		
		TransactionHistory.record_export(job, perf)
		
		PhaseProfiler.discard(job.job_id)
	end

	if clusterio_api and clusterio_api.send_json then
		local event_payload = {
			export_id = export_id,
			platform_name = job.platform_name,
			platform_index = job.platform_index,
			entity_count = job.total_entities,
			duration_ticks = duration_ticks,
			duration_seconds = duration_seconds,
			destination_instance_id = job.destination_instance_id,
			export_metrics = {
				async_export_ticks = duration_ticks,
				async_export_ms = duration_ms,
				async_export_seconds = duration_seconds,
				entity_count = job.total_entities,
				tile_count = exported_tile_count,
				atomic_belt_entities = belt_scan_count,
				atomic_belt_item_stacks = belt_item_total,
				uncompressed_bytes = uncompressed_bytes,
				compressed_bytes = compressed_bytes,
				compression_reduction_pct = compression_reduction_pct,
				schedule_record_count = export_schedule_summary.record_count,
				schedule_interrupt_count = export_schedule_summary.interrupt_count,
			},
		}

		if job.destination_instance_id then
			log(string.format("[send_json] Sending export notification: %s (%d entities) → transfer to instance %d",
				export_id, job.total_entities, job.destination_instance_id))
		else
			log(string.format("[send_json] Sending export notification: %s (%d entities)", export_id, job.total_entities))
		end
		local send_success, send_err = pcall(function()
			clusterio_api.send_json("surface_export_complete", event_payload)
		end)

		if send_success then
			log("[send_json] Export notification sent successfully")
		else
			log(string.format("[send_json ERROR] Failed to send notification: %s", tostring(send_err)))
		end
	else
		log("[WARN] clusterio_api not available, export notification not sent to plugin")
	end

	storage.async_job_results[job.job_id] = {
		status = "complete",
		complete = true,
		type = "export",
		job_id = job.job_id,
		platform_name = job.platform_name,
		total_entities = job.total_entities,
		duration_ticks = duration_ticks,
		duration_seconds = duration_seconds,
		progress = 100,
		requester = job.requester
	}
	JobResults.prune(25)

	handle_pending_file_write(export_id)

	if not job.destination_instance_id then
		local unlock_success = SurfaceLock.unlock_platform(job.platform_index)
		if unlock_success then
			game.print(string.format("[Export] Platform %s unlocked - machines reactivated", job.platform_name), {0, 1, 0})
			if clusterio_api and clusterio_api.send_json then
				GameUtils.pcall_warn("[ExportPipeline] send_json surface_platform_state_changed", function()
					clusterio_api.send_json("surface_platform_state_changed", {
						platform_name = job.platform_name,
						force_name = job.force_name,
					})
				end)
			end
		end
	else
		log(string.format("[Export] Skipping unlock for transfer - platform %s will be deleted", job.platform_name))
	end

	ExportCache.prune_to_configured_cap()

	if job.clone_dest_name then
		job.export_data.platform_name = job.clone_dest_name
		job.export_data.platform.name = job.clone_dest_name
		local import_job_id, import_err = ImportPipeline.queue(job.export_data, job.clone_dest_name, job.force_name, "clone")
		if import_job_id then
			log(string.format("[Clone Platform] Import queued from completed export %s: job=%s, platform='%s'",
				export_id, import_job_id, job.clone_dest_name))
		else
			log(string.format("[Clone Platform] FAILED to queue import for '%s': %s",
				job.clone_dest_name, tostring(import_err)))
			game.print(string.format("[Clone Platform] Import FAILED for '%s': %s",
				job.clone_dest_name, tostring(import_err)), {1, 0, 0})
		end
	end

	storage.async_jobs[job.job_id] = nil
end

function ExportPipeline.run_blueprint_diff(job)
	local force = game.forces[job.force_name]
	local platform = force and force.platforms[job.platform_index]
	local surface = platform and platform.surface
	if not (surface and surface.valid) then
		log(string.format("[BlueprintDiff] no surface for '%s' — property diff skipped", tostring(job.platform_name)))
		return
	end

	local by_id = {}
	for _, entity_data in ipairs(job.export_data.entities or {}) do
		if entity_data.entity_id ~= nil then
			by_id[entity_data.entity_id] = entity_data
		end
	end

	local result, err = BlueprintDiff.scan(surface, force, by_id)
	if not result then
		log(string.format("[BlueprintDiff] status=UNAVAILABLE for '%s': %s — no property comparison was made; "
			.. "this is NOT a clean bill of health. Transfer unaffected.",
			tostring(job.platform_name), tostring(err)))
		job.export_data.blueprint_diff = { status = "UNAVAILABLE", error = tostring(err) }
		return
	end

	job.export_data.blueprint_diff = {
		status = result.status,
		blueprint_entity_count = result.blueprint_entity_count,
		unpaired_entity_count = result.unpaired_entity_count,
	}
	log({ "", string.format("[BlueprintDiff] status=%s '%s': compared %d blueprint entities, %d unpaired, elapsed ",
		result.status, tostring(job.platform_name), result.blueprint_entity_count, result.unpaired_entity_count),
		result.profiler })
	if result.status == "UNKNOWN" then
		log(string.format("[BlueprintDiff][WARN] status=UNKNOWN for '%s': %d blueprint entities could not be paired "
			.. "to serialized data, so their properties were compared against NOTHING. Zero findings here does not "
			.. "mean zero loss.", tostring(job.platform_name), result.unpaired_entity_count))
	end
	local verdict = job.census_verdict or {}
	verdict.property_findings = verdict.property_findings or {}
	for _, finding in ipairs(result.findings) do
		verdict.property_findings[#verdict.property_findings + 1] = finding
	end
	job.census_verdict = verdict
end

function ExportPipeline.report_property_findings(job)
	local findings = (job.census_verdict or {}).property_findings or {}
	job.export_data.property_findings = findings
	if #findings == 0 then
		return
	end
	local by_property = {}
	for _, finding in ipairs(findings) do
		local key = finding.property .. ":" .. finding.kind
		by_property[key] = (by_property[key] or 0) + 1
	end
	local parts = {}
	for key, count in pairs(by_property) do
		parts[#parts + 1] = key .. "=" .. count
	end
	table.sort(parts)
	log(string.format(
		"[PropertyCensus][WARN] '%s': %d property finding(s) — %s. The transfer is NOT blocked: "
		.. "items and fluids are exact, but this entity state did not reach the payload intact.",
		job.platform_name, #findings, table.concat(parts, " ")))
	for _, finding in ipairs(findings) do
		log(string.format("[PropertyCensus][WARN]   %s %s on %s @%s,%s live=%s serialized=%s",
			finding.kind, finding.property, finding.entity_name,
			finding.position.x, finding.position.y,
			tostring(finding.live), tostring(finding.serialized)))
	end
end

function ExportPipeline.abort_transfer_on_census_mismatch(job)
	local verdict = job.census_verdict or { mismatches = {}, totals = {} }
	local mismatch_count = #(verdict.mismatches or {})
	local safe_name = string.gsub(job.platform_name or "unknown", "[^%w_-]", "_")
	local filename = string.format("census_%s_%d.json", safe_name, game.tick)

	local bundle = {
		reason = "source_census_mismatch",
		platform_name = job.platform_name,
		platform_index = job.platform_index,
		destination_instance_id = job.destination_instance_id,
		gate_tick = game.tick,
		started_tick = job.started_tick,
		verdict_ok = verdict.ok,
		mismatch_count = mismatch_count,
		mismatches = verdict.mismatches,
		totals = verdict.totals,
	}
	local written = DebugExport.write_failure_black_box(filename, bundle)

	log(string.format(
		"[Census][ABORT] Transfer export '%s' ABORTED — source census mismatch: %d row(s); destination NOT contacted; source preserved. Bundle=%s",
		job.platform_name, mismatch_count, tostring(written)))
	game.print(string.format(
		"[Census] Transfer of '%s' ABORTED — source serialization mismatch detected; source preserved.",
		job.platform_name), {1, 0.3, 0})

	local unlock_success = SurfaceLock.unlock_platform(job.platform_index)
	if unlock_success and clusterio_api and clusterio_api.send_json then
		GameUtils.pcall_warn("[ExportPipeline] send_json surface_platform_state_changed (census abort)", function()
			clusterio_api.send_json("surface_platform_state_changed", {
				platform_name = job.platform_name,
				force_name = job.force_name,
			})
		end)
	end

	if clusterio_api and clusterio_api.send_json then
		GameUtils.pcall_warn("[ExportPipeline] send_json surface_export_complete (census abort)", function()
			clusterio_api.send_json("surface_export_complete", {
				export_id = "export_failed_census_" .. safe_name,
				platform_name = job.platform_name,
				platform_index = job.platform_index,
				destination_instance_id = job.destination_instance_id,
				census_failure = true,
				census_mismatch_count = mismatch_count,
				failure_black_box = written,
			})
		end)
	end

	if job.requester == "RCON" then
		rcon.print(string.format("EXPORT_FAILED:census_mismatch:%s", job.platform_name))
	end

	storage.async_job_results[job.job_id] = {
		status = "failed",
		complete = true,
		failed = true,
		type = "export",
		job_id = job.job_id,
		platform_name = job.platform_name,
		error = "source_census_mismatch",
		census_mismatch_count = mismatch_count,
		requester = job.requester,
	}
	JobResults.prune(25)

	PhaseProfiler.discard(job.job_id)
	storage.async_jobs[job.job_id] = nil
end

return ExportPipeline
